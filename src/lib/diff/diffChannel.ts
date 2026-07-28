/*
Diff channels abstract the transport used for live editing. Offline editing stays local
with BroadcastChannel, while online editing polls the branch API and excludes events
originating from the current client to avoid replaying our own writes.
*/

import type {
  DropBranchRuntimeFact,
  DropDiffEnvelope,
  DropDiffEvent,
  DropDiffEventMetadata,
  DropDiffOp,
  DropDiffPollResponse,
} from "../../../shared/drop/diff";
import { NULLDOWN_ACCOUNT_ID_HEADER } from "../../../shared/drop/branch";
import { emitEvent } from "../events/eventBus";

/** One received branch transport batch. */
export interface DiffChannelBatch {
  /** Markdown diff events after the current event cursor. */
  events: DropDiffEvent[];
  /** Runtime facts after the independent fact cursor. */
  facts: DropBranchRuntimeFact[];
}

export type DiffChannelListener = (batch: DiffChannelBatch) => void;

export interface DiffChannel {
  readonly dropId: string;
  readonly clientId: string;
  publish: (ops: DropDiffOp[], options?: DiffChannelPublishOptions) => Promise<void>;
  poll: () => Promise<DiffChannelBatch>;
  subscribe: (listener: DiffChannelListener) => () => void;
  start: () => void;
  stop: () => void;
  readonly cursor: string | null;
  readonly factCursor: string | null;
}

export interface DiffChannelPublishOptions {
  metadata?: DropDiffEventMetadata;
}

const generateClientId = (): string => {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }

  return `client_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
};

let globalEventCounter = 0;

const nextEventId = (clientId: string): string => {
  globalEventCounter += 1;
  return `${clientId}:${Date.now()}:${globalEventCounter}`;
};

/* Remote diff channel (polls /api/diff/:id). */

export interface RemoteDiffChannelOptions {
  dropId: string;
  branchId?: string | null;
  accountId?: string | null;
  clientId?: string;
  authToken?: string | null;
  authTokenProvider?: (() => Promise<string | null>) | null;
  pollIntervalMs?: number;
  initialCursor?: string | null;
  initialFactCursor?: string | null;
  enableRuntimeFacts?: boolean;
}

const DEFAULT_POLL_INTERVAL_MS = 3000;

export const createRemoteDiffChannel = (
  options: RemoteDiffChannelOptions,
): DiffChannel => {
  const dropId = options.dropId;
  const branchId = options.branchId ?? null;
  const accountId = options.accountId ?? null;
  const authToken = options.authToken ?? null;
  const authTokenProvider = options.authTokenProvider ?? null;
  const clientId = options.clientId ?? generateClientId();
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  let cursor: string | null = options.initialCursor ?? null;
  let factCursor: string | null = options.initialFactCursor ?? null;
  const enableRuntimeFacts = options.enableRuntimeFacts ?? false;
  let timer: ReturnType<typeof setInterval> | null = null;
  const listeners = new Set<DiffChannelListener>();
  let localSeq = 0;
  let hasCompletedHandshake = false;
  let pollInFlight = false;

  const buildHeaders = async (): Promise<HeadersInit> => {
    const headers: Record<string, string> = {
      "x-nulldown-client-id": clientId,
    };

    if (accountId) {
      headers[NULLDOWN_ACCOUNT_ID_HEADER] = accountId;
    }

    const bearerToken = authToken ?? (await authTokenProvider?.());
    if (bearerToken) {
      headers.Authorization = `Bearer ${bearerToken}`;
    }

    return headers;
  };

  const buildDiffUrl = (params?: URLSearchParams): string => {
    const nextParams = new URLSearchParams(params);
    if (branchId) {
      nextParams.set("branchId", branchId);
    }

    const query = nextParams.toString();
    return query
      ? `/api/diff/${encodeURIComponent(dropId)}?${query}`
      : `/api/diff/${encodeURIComponent(dropId)}`;
  };

  const doHandshake = async (): Promise<boolean> => {
    const params = new URLSearchParams({ cursor: "__latest__" });
    const response = await fetch(buildDiffUrl(params), {
      headers: await buildHeaders(),
    });

    if (!response.ok) {
      console.error("[diff-channel] Handshake failed:", response.statusText);
      return false;
    }

    const data = (await response.json()) as DropDiffPollResponse;

    // Start from the current branch head so opening an editor does not replay the entire backlog.
    if (data.cursor !== null) {
      cursor = data.cursor;
    }
    hasCompletedHandshake = true;
    return true;
  };

  const publish = async (
    ops: DropDiffOp[],
    options: DiffChannelPublishOptions = {},
  ): Promise<void> => {
    if (!ops.length) return;

    const event: DropDiffEvent = {
      eventId: nextEventId(clientId),
      seq: 0,
      dropId,
      sourceClientId: clientId,
      createdAt: Date.now(),
      ops,
      metadata: options.metadata,
    };

    const envelope: DropDiffEnvelope = {
      version: 1,
      events: [event],
    };

    const requestHeaders = await buildHeaders();
    const response = await fetch(buildDiffUrl(), {
      method: "POST",
      headers: {
        ...(requestHeaders as Record<string, string>),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(envelope),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(body || `Failed to publish diffs: ${response.statusText}`);
    }
  };

  const poll = async (): Promise<DiffChannelBatch> => {
    const params = new URLSearchParams();
    if (cursor !== null) {
      params.set("cursor", cursor);
    }
    if (enableRuntimeFacts) {
      params.set("factCursor", factCursor ?? "-1");
    }
    params.set("excludeClient", clientId);

    const response = await fetch(buildDiffUrl(params), {
      headers: await buildHeaders(),
    });

    if (!response.ok) {
      console.error("[diff-channel] Poll failed:", response.statusText);
      return { events: [], facts: [] };
    }

    const data = (await response.json()) as DropDiffPollResponse;

    if (data.cursor !== null) {
      cursor = data.cursor;
    }
    if (
      enableRuntimeFacts &&
      data.factCursor !== undefined &&
      data.factCursor !== null
    ) {
      factCursor = data.factCursor;
    }

    return { events: data.events, facts: data.facts ?? [] };
  };

  const runPoll = async () => {
    if (pollInFlight) return;
    pollInFlight = true;
    try {
      if (!hasCompletedHandshake) {
        if (!(await doHandshake())) return;
      }

      const batch = await poll();
      if (batch.events.length > 0) {
        emitEvent("diff:received", { dropId, count: batch.events.length });
      }
      if (batch.events.length > 0 || batch.facts.length > 0) {
        listeners.forEach((listener) => {
          try {
            listener(batch);
          } catch (error) {
            console.error("[diff-channel] Listener error:", error);
          }
        });
      }
    } catch (error) {
      console.error("[diff-channel] Poll error:", error);
    } finally {
      pollInFlight = false;
    }
  };

  const subscribe = (listener: DiffChannelListener): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const start = () => {
    if (timer) return;
    timer = setInterval(runPoll, pollIntervalMs);
    // Fire an initial poll immediately
    void runPoll();
  };

  const stop = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  return {
    dropId,
    clientId,
    publish,
    poll,
    subscribe,
    start,
    stop,
    get cursor() {
      return cursor;
    },
    get factCursor() {
      return factCursor;
    },
  };
};

/* Local diff channel (BroadcastChannel + in-memory). */

export interface LocalDiffChannelOptions {
  dropId: string;
  clientId?: string;
}

export const createLocalDiffChannel = (
  options: LocalDiffChannelOptions,
): DiffChannel => {
  const dropId = options.dropId;
  const clientId = options.clientId ?? generateClientId();
  const listeners = new Set<DiffChannelListener>();
  let localSeq = 0;
  let broadcastChannel: BroadcastChannel | null = null;

  const channelName = `nulldown_diff_${dropId}`;

  const initBroadcast = () => {
    if (typeof BroadcastChannel === "undefined") return;
    if (broadcastChannel) return;

    broadcastChannel = new BroadcastChannel(channelName);
    broadcastChannel.onmessage = (event) => {
      const data = event.data as {
        sourceClientId?: string;
        events?: DropDiffEvent[];
      };

      if (data.sourceClientId === clientId) return;
      if (!Array.isArray(data.events) || !data.events.length) return;

      listeners.forEach((listener) => {
        try {
          listener({ events: data.events!, facts: [] });
        } catch (error) {
          console.error("[local-diff-channel] Listener error:", error);
        }
      });
    };
  };

  const publish = async (
    ops: DropDiffOp[],
    options: DiffChannelPublishOptions = {},
  ): Promise<void> => {
    if (!ops.length) return;

    localSeq += 1;
    const event: DropDiffEvent = {
      eventId: nextEventId(clientId),
      seq: localSeq,
      dropId,
      sourceClientId: clientId,
      createdAt: Date.now(),
      ops,
      metadata: options.metadata,
    };

    // Local state already applied this diff; the broadcast is only for sibling tabs.
    broadcastChannel?.postMessage({
      sourceClientId: clientId,
      events: [event],
    });
  };

  const poll = async (): Promise<DiffChannelBatch> => {
    return { events: [], facts: [] };
  };

  const subscribe = (listener: DiffChannelListener): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const start = () => {
    initBroadcast();
  };

  const stop = () => {
    broadcastChannel?.close();
    broadcastChannel = null;
  };

  return {
    dropId,
    clientId,
    publish,
    poll,
    subscribe,
    start,
    stop,
    get cursor() {
      return null;
    },
    get factCursor() {
      return null;
    },
  };
};

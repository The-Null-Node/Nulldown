/*
Diff channels abstract the transport used for live editing. Offline editing stays local
with BroadcastChannel, while online editing polls the branch API and excludes events
originating from the current client to avoid replaying our own writes.
*/

import type {
  DropDiffAppendResponse,
  DropDiffEnvelope,
  DropDiffEvent,
  DropDiffOp,
  DropDiffPollResponse,
} from "../../../shared/drop/diff";
import {
  hasConfirmedDropDiffAppendReceipt,
  isDropDiffEvent,
} from "../../../shared/drop/diff";
import { DropDiffAppendEnvelopeSchema } from "../../../shared/drop/codecs/diff-v1";
import { NULLDOWN_ACCOUNT_ID_HEADER } from "../../../shared/drop/branch";
import { emitEvent } from "../events/eventBus";
import {
  createDiffChannelClientId,
  createDiffChannelEventId,
  DiffChannelError,
  serializeDiffChannelEventIdentity,
  type DiffChannel,
  type DiffChannelBatch,
  type DiffChannelListener,
  type DiffChannelPublishAck,
  type DiffChannelPublishOptions,
} from "./channel";

const responseError = async (response: Response): Promise<DiffChannelError> => {
  const body = await response.text();
  try {
    const parsed = JSON.parse(body) as { error?: unknown; code?: unknown };
    if (typeof parsed.error === "string") {
      return new DiffChannelError({
        message: parsed.error,
        status: response.status,
        code: typeof parsed.code === "string" ? parsed.code : null,
      });
    }
  } catch {
    // Non-JSON legacy transport failures retain the response text below.
  }

  return new DiffChannelError({
    message: body || `Failed to publish diffs: ${response.statusText}`,
    status: response.status,
  });
};

/* Remote diff channel (polls /api/diff/:id). */

export interface RemoteDiffChannelOptions {
  dropId: string;
  branchId?: string | null;
  accountId?: string | null;
  clientId?: string;
  authToken?: string | null;
  authTokenProvider?:
    ((options?: { forceRefresh?: boolean }) => Promise<string | null>) | null;
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
  const clientId = options.clientId ?? createDiffChannelClientId();
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  let cursor: string | null = options.initialCursor ?? null;
  let factCursor: string | null = options.initialFactCursor ?? null;
  const enableRuntimeFacts = options.enableRuntimeFacts ?? false;
  let timer: ReturnType<typeof setInterval> | null = null;
  const listeners = new Set<DiffChannelListener>();
  let hasCompletedHandshake = options.initialCursor !== undefined;
  let pollInFlight = false;
  const preparedEvents = new Map<string, DropDiffEvent>();

  const buildHeaders = async (authOptions?: {
    forceRefresh?: boolean;
  }): Promise<HeadersInit> => {
    const headers: Record<string, string> = {
      "x-nulldown-client-id": clientId,
    };

    if (accountId) {
      headers[NULLDOWN_ACCOUNT_ID_HEADER] = accountId;
    }

    const bearerToken = authToken ?? (await authTokenProvider?.(authOptions));
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

  const publishEvent = async (
    candidate: DropDiffEvent,
  ): Promise<DropDiffAppendResponse> => {
    if (
      !isDropDiffEvent(candidate) ||
      !DropDiffAppendEnvelopeSchema.safeParse({
        version: 1,
        events: [candidate],
      }).success ||
      candidate.dropId !== dropId
    ) {
      throw new Error("Invalid immutable diff event for this channel.");
    }
    const existing = preparedEvents.get(candidate.eventId);
    if (
      existing &&
      serializeDiffChannelEventIdentity(existing) !==
        serializeDiffChannelEventIdentity(candidate)
    ) {
      throw new Error(
        `Diff event ${candidate.eventId} was already prepared with different data.`,
      );
    }
    const event = existing ?? candidate;
    preparedEvents.set(event.eventId, event);

    const envelope: DropDiffEnvelope = {
      version: 1,
      events: [event],
    };

    const body = JSON.stringify(envelope);
    const post = async (forceRefresh = false): Promise<Response> => {
      const requestHeaders = await buildHeaders(
        forceRefresh ? { forceRefresh: true } : undefined,
      );
      return fetch(buildDiffUrl(), {
        method: "POST",
        headers: {
          ...(requestHeaders as Record<string, string>),
          "Content-Type": "application/json",
        },
        body,
      });
    };

    let response = await post();
    if (response.status === 401 && !authToken) {
      response = await post(true);
    }

    if (!response.ok) {
      throw await responseError(response);
    }

    const data = await response.json();
    if (
      !hasConfirmedDropDiffAppendReceipt(data, {
        branchId: branchId ?? undefined,
        eventIds: [event.eventId],
      })
    ) {
      throw new DiffChannelError({
        message: `Diff publish receipt is unconfirmed for event ${event.eventId}.`,
        code: "diff_receipt_unconfirmed",
      });
    }
    preparedEvents.delete(event.eventId);
    return data;
  };

  const publish = async (
    ops: DropDiffOp[],
    options: DiffChannelPublishOptions = {},
  ): Promise<DiffChannelPublishAck[]> => {
    if (!ops.length) return [];
    if ((options.eventId === undefined) !== (options.createdAt === undefined)) {
      throw new Error(
        "Diff retries must provide eventId and createdAt together.",
      );
    }

    const response = await publishEvent({
      eventId: options.eventId ?? createDiffChannelEventId(clientId),
      seq: 0,
      dropId,
      sourceClientId: clientId,
      createdAt: options.createdAt ?? Date.now(),
      ops,
      metadata: options.metadata,
    });
    return response.acknowledgements;
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
    publishEvent,
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

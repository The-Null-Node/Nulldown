import type {
  DropDiffEnvelope,
  DropDiffEvent,
  DropDiffOp,
  DropDiffPollResponse,
} from "../../../shared/drop/diff";

export type DiffChannelListener = (events: DropDiffEvent[]) => void;

export interface DiffChannel {
  readonly dropId: string;
  readonly clientId: string;
  publish: (ops: DropDiffOp[]) => Promise<void>;
  poll: () => Promise<DropDiffEvent[]>;
  subscribe: (listener: DiffChannelListener) => () => void;
  start: () => void;
  stop: () => void;
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

// --- Remote diff channel (polls /api/diff/:id) ---

export interface RemoteDiffChannelOptions {
  dropId: string;
  clientId?: string;
  pollIntervalMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 3000;

export const createRemoteDiffChannel = (
  options: RemoteDiffChannelOptions,
): DiffChannel => {
  const dropId = options.dropId;
  const clientId = options.clientId ?? generateClientId();
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  let cursor: string | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  const listeners = new Set<DiffChannelListener>();
  let localSeq = 0;

  const publish = async (ops: DropDiffOp[]): Promise<void> => {
    if (!ops.length) return;

    const event: DropDiffEvent = {
      eventId: nextEventId(clientId),
      seq: 0, // server assigns canonical seq
      dropId,
      sourceClientId: clientId,
      createdAt: Date.now(),
      ops,
    };

    const envelope: DropDiffEnvelope = {
      version: 1,
      events: [event],
    };

    const response = await fetch(`/api/diff/${encodeURIComponent(dropId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(envelope),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(body || `Failed to publish diffs: ${response.statusText}`);
    }
  };

  const poll = async (): Promise<DropDiffEvent[]> => {
    const params = new URLSearchParams();
    if (cursor !== null) {
      params.set("cursor", cursor);
    }
    params.set("excludeClient", clientId);

    const response = await fetch(
      `/api/diff/${encodeURIComponent(dropId)}?${params.toString()}`,
    );

    if (!response.ok) {
      console.error("[diff-channel] Poll failed:", response.statusText);
      return [];
    }

    const data = (await response.json()) as DropDiffPollResponse;

    if (data.cursor !== null) {
      cursor = data.cursor;
    }

    return data.events;
  };

  const runPoll = async () => {
    try {
      const events = await poll();
      if (events.length > 0) {
        listeners.forEach((listener) => {
          try {
            listener(events);
          } catch (error) {
            console.error("[diff-channel] Listener error:", error);
          }
        });
      }
    } catch (error) {
      console.error("[diff-channel] Poll error:", error);
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
  };
};

// --- Local diff channel (BroadcastChannel + in-memory) ---

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
          listener(data.events!);
        } catch (error) {
          console.error("[local-diff-channel] Listener error:", error);
        }
      });
    };
  };

  const publish = async (ops: DropDiffOp[]): Promise<void> => {
    if (!ops.length) return;

    localSeq += 1;
    const event: DropDiffEvent = {
      eventId: nextEventId(clientId),
      seq: localSeq,
      dropId,
      sourceClientId: clientId,
      createdAt: Date.now(),
      ops,
    };

    // Broadcast to other tabs
    broadcastChannel?.postMessage({
      sourceClientId: clientId,
      events: [event],
    });
  };

  const poll = async (): Promise<DropDiffEvent[]> => {
    // Local channel is push-only via BroadcastChannel; nothing to poll.
    return [];
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
  };
};

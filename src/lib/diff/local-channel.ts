import type {
  DropDiffAppendResponse,
  DropDiffEvent,
  DropDiffOp,
} from "../../../shared/drop/diff";
import { isDropDiffEvent } from "../../../shared/drop/diff";
import {
  createDiffChannelClientId,
  createDiffChannelEventId,
  serializeDiffChannelEventIdentity,
  type DiffChannel,
  type DiffChannelBatch,
  type DiffChannelListener,
  type DiffChannelPublishAck,
  type DiffChannelPublishOptions,
} from "./channel";

/** Construction options for a browser-local diff channel. */
export interface LocalDiffChannelOptions {
  dropId: string;
  clientId?: string;
}

/** Creates an in-memory channel that broadcasts accepted events to sibling tabs. */
export const createLocalDiffChannel = (
  options: LocalDiffChannelOptions,
): DiffChannel => {
  const dropId = options.dropId;
  const clientId = options.clientId ?? createDiffChannelClientId();
  const listeners = new Set<DiffChannelListener>();
  let localSeq = 0;
  let broadcastChannel: BroadcastChannel | null = null;
  const localEvents = new Map<
    string,
    { event: DropDiffEvent; acknowledgement: DiffChannelPublishAck }
  >();
  const channelName = `nulldown_diff_${dropId}`;

  const initBroadcast = () => {
    if (typeof BroadcastChannel === "undefined" || broadcastChannel) return;
    broadcastChannel = new BroadcastChannel(channelName);
    broadcastChannel.onmessage = (message) => {
      const data = message.data as {
        sourceClientId?: string;
        events?: DropDiffEvent[];
      };
      if (data.sourceClientId === clientId || !data.events?.length) return;
      listeners.forEach((listener) => {
        try {
          listener({ events: data.events!, facts: [] });
        } catch (error) {
          console.error("[local-diff-channel] Listener error:", error);
        }
      });
    };
  };

  const publishEvent = async (
    candidate: DropDiffEvent,
  ): Promise<DropDiffAppendResponse> => {
    if (!isDropDiffEvent(candidate) || candidate.dropId !== dropId) {
      throw new Error("Invalid immutable diff event for this channel.");
    }
    const existing = localEvents.get(candidate.eventId);
    if (existing) {
      if (
        serializeDiffChannelEventIdentity(existing.event) !==
        serializeDiffChannelEventIdentity(candidate)
      ) {
        throw new Error(
          `Diff event ${candidate.eventId} was already prepared with different data.`,
        );
      }
      return {
        accepted: 0,
        deduplicated: 1,
        branchId: dropId,
        snapshotId: existing.acknowledgement.snapshotId,
        totalStored: localEvents.size,
        acknowledgements: [
          { ...existing.acknowledgement, status: "duplicate" },
        ],
      };
    }

    localSeq += 1;
    const event = { ...candidate, seq: localSeq };
    const acknowledgement: DiffChannelPublishAck = {
      eventId: event.eventId,
      seq: event.seq,
      snapshotId: event.seq,
      status: "accepted",
    };
    localEvents.set(event.eventId, { event, acknowledgement });
    broadcastChannel?.postMessage({
      sourceClientId: clientId,
      events: [event],
    });
    return {
      accepted: 1,
      deduplicated: 0,
      branchId: dropId,
      snapshotId: acknowledgement.snapshotId,
      totalStored: localEvents.size,
      acknowledgements: [acknowledgement],
    };
  };

  const publish = async (
    ops: DropDiffOp[],
    publishOptions: DiffChannelPublishOptions = {},
  ): Promise<DiffChannelPublishAck[]> => {
    if (!ops.length) return [];
    if (
      (publishOptions.eventId === undefined) !==
      (publishOptions.createdAt === undefined)
    ) {
      throw new Error(
        "Diff retries must provide eventId and createdAt together.",
      );
    }
    const response = await publishEvent({
      eventId: publishOptions.eventId ?? createDiffChannelEventId(clientId),
      seq: 0,
      dropId,
      sourceClientId: clientId,
      createdAt: publishOptions.createdAt ?? Date.now(),
      ops,
      metadata: publishOptions.metadata,
    });
    return response.acknowledgements;
  };

  const poll = async (): Promise<DiffChannelBatch> => ({
    events: [],
    facts: [],
  });
  const subscribe = (listener: DiffChannelListener): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  return {
    dropId,
    clientId,
    publish,
    publishEvent,
    poll,
    subscribe,
    start: initBroadcast,
    stop: () => {
      broadcastChannel?.close();
      broadcastChannel = null;
    },
    get cursor() {
      return null;
    },
    get factCursor() {
      return null;
    },
  };
};

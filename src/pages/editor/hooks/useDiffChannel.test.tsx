/** @jest-environment jsdom */

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { IDBKeyRange as fakeIDBKeyRange, indexedDB } from "fake-indexeddb";
import { jest } from "@jest/globals";
import { TextDecoder, TextEncoder } from "node:util";
import { deserialize, serialize } from "node:v8";
import { useEffect } from "react";
import type {
  DropDiffAppendResponse,
  DropDiffEvent,
} from "../../../../shared/drop/diff";
import { DiffOp, type Diff } from "../../../../shared/nulledit/types";
import type {
  DiffChannel,
  DiffChannelBatch,
  DiffChannelListener,
} from "../../../lib/diff/diffChannel";
import {
  acquireDiffOutboxWriterLease,
  hasDiffOutboxWriterLease,
  listDiffOutboxEvents,
  readDiffOutboxBranchDraft,
} from "../../../lib/diff/diffOutboxStore";
import { resetNulldownDatabaseForTests } from "../../../lib/indexedDb";
import type { DiffSyncState, UseDiffChannelOptions } from "./useDiffChannel";

const scope = { rootId: "root-1", branchId: "branch-1" };
const clientId = "client-1";
const cloneForTest = (value: unknown): unknown => deserialize(serialize(value));

Object.assign(globalThis, {
  TextDecoder,
  TextEncoder,
  structuredClone: cloneForTest,
});

const acknowledgement = (
  eventId: string,
  status: "accepted" | "duplicate" = "accepted",
): DropDiffAppendResponse => ({
  accepted: status === "accepted" ? 1 : 0,
  deduplicated: status === "duplicate" ? 1 : 0,
  branchId: scope.branchId,
  snapshotId: 8,
  totalStored: 8,
  acknowledgements: [{ eventId, seq: 7, snapshotId: 8, status }],
});

class ControlledDiffChannel implements DiffChannel {
  readonly dropId: string;
  readonly clientId: string;
  readonly cursor = null;
  readonly factCursor = null;
  readonly publish = jest.fn(async () => []);
  readonly start = jest.fn();
  readonly stop = jest.fn();
  private readonly listeners = new Set<DiffChannelListener>();

  constructor(dropId: string, clientId: string) {
    this.dropId = dropId;
    this.clientId = clientId;
  }

  publishEvent = async (event: DropDiffEvent): Promise<DropDiffAppendResponse> =>
    publishEvent(event);

  poll = async (): Promise<DiffChannelBatch> => ({ events: [], facts: [] });

  subscribe = (listener: DiffChannelListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  emit(batch: DiffChannelBatch): void {
    this.listeners.forEach((listener) => listener(batch));
  }
}

const channels = new Map<string, ControlledDiffChannel>();
const publishedEvents: DropDiffEvent[] = [];
let loseResponse = false;
let deliveryGate: Promise<void> | null = null;

const publishEvent = async (event: DropDiffEvent): Promise<DropDiffAppendResponse> => {
  publishedEvents.push(event);
  if (deliveryGate) await deliveryGate;
  if (loseResponse) {
    throw new Error("response lost after acceptance");
  }
  return acknowledgement(event.eventId, publishedEvents.length === 1 ? "accepted" : "duplicate");
};

jest.unstable_mockModule("../../../lib/diff/diffChannel", () => ({
  createRemoteDiffChannel: (options: { dropId: string; clientId?: string }) => {
    const channel = new ControlledDiffChannel(options.dropId, options.clientId ?? "generated");
    channels.set(channel.clientId, channel);
    return channel;
  },
  createLocalDiffChannel: (options: { dropId: string; clientId?: string }) =>
    new ControlledDiffChannel(options.dropId, options.clientId ?? "generated"),
}));

const { useDiffChannel } = await import("./useDiffChannel");
const { applyDiff } = await import("../../../../shared/nulledit/textDiff");

interface HookHandle {
  syncState: DiffSyncState;
  publishDiffs: (
    diffs: Diff[],
    options?: { eventId?: string; createdAt?: number; draftContent?: string },
  ) => Promise<unknown>;
  takeOverEditing: () => Promise<void>;
  discardSyncConflict: () => Promise<void>;
  flushPendingDiffs: () => Promise<void>;
}

interface HookHarnessProps {
  options: UseDiffChannelOptions;
  onUpdate: (value: HookHandle) => void;
}

const HookHarness = ({ options, onUpdate }: HookHarnessProps) => {
  const result = useDiffChannel(options);
  useEffect(() => {
    onUpdate(result);
  });
  return <output>{`${result.syncState.mode}:${result.syncState.pendingCount}`}</output>;
};

const createInsertDiff = (text: string): Diff => ({
  op: DiffOp.INSERT,
  data: new TextEncoder().encode(text).buffer as ArrayBuffer,
  range: { start: 0, end: 0 },
});

const createOptions = (
  overrides: Partial<UseDiffChannelOptions> = {},
): UseDiffChannelOptions => ({
  dropId: scope.rootId,
  branchId: scope.branchId,
  accountId: "account-1",
  clientId,
  initialHeadSeq: 7,
  isOffline: true,
  editor: null,
  ...overrides,
});

const foreignEvent = (): DropDiffEvent => ({
  eventId: "other-client-event",
  seq: 8,
  dropId: scope.rootId,
  sourceClientId: "other-client",
  createdAt: 1_725_000_000_100,
  ops: [{ type: "insert", start: 0, end: 0, text: "remote" }],
});

describe("useDiffChannel durable browser outbox", () => {
  beforeEach(async () => {
    channels.clear();
    publishedEvents.length = 0;
    loseResponse = false;
    deliveryGate = null;
    Object.defineProperty(window, "indexedDB", { value: indexedDB, configurable: true });
    Object.defineProperty(globalThis, "IDBKeyRange", {
      value: fakeIDBKeyRange,
      configurable: true,
    });
    await resetNulldownDatabaseForTests();
  });

  afterEach(async () => {
    cleanup();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await resetNulldownDatabaseForTests();
  });

  it("persists subsequent keypresses while the first network delivery is pending", async () => {
    let handle: HookHandle | null = null;
    render(<HookHarness options={createOptions({ isOffline: false })} onUpdate={(value) => { handle = value; }} />);
    await waitFor(() => expect(handle?.syncState.mode).toBe("synced"));
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const send = jest.spyOn(channels.get(clientId)!, "publishEvent").mockImplementation(async (event) => {
      await pending;
      return acknowledgement(event.eventId);
    });
    try {
      await act(async () => {
        void handle!.publishDiffs([createInsertDiff("first")], {
          eventId: "in-flight", createdAt: 1, draftContent: "first",
        });
      });
      await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
      await act(async () => {
        void handle!.publishDiffs([createInsertDiff("second")], {
          eventId: "durable-second", createdAt: 2, draftContent: "secondfirst",
        });
      });
      await waitFor(async () => {
        expect((await listDiffOutboxEvents(scope)).map((entry) => entry.eventId))
          .toEqual(["in-flight", "durable-second"]);
        expect(await readDiffOutboxBranchDraft(scope)).toMatchObject({ content: "secondfirst" });
      });
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await act(async () => { await handle!.flushPendingDiffs(); });
    }
  });

  it.each([false, true])("does not replay recovered old-client edits after reload (takeover: %s), but still applies foreign edits", async (takeover) => {
    const base = "FIRST SECOND.";
    const expected = "FIRST SECOND RECOVER.";
    let content = base;
    let handle: HookHandle | null = null;
    let release!: () => void;
    deliveryGate = new Promise<void>((resolve) => { release = resolve; });
    const editor = { addDiffs: jest.fn((diffs: Diff[]) => {
      content = diffs.reduce((text, diff) => applyDiff(text, diff), content);
    }) };
    const first = render(<HookHarness options={createOptions({ isOffline: false, editor })}
      onUpdate={(value) => { handle = value; }} />);
    try {
      await waitFor(() => expect(handle?.syncState.mode).toBe("synced"));
      await act(async () => {
        for (const [index, character] of [..." RECOVER"].entries()) {
          const position = base.length - 1 + index;
          const diff = { ...createInsertDiff(character), range: { start: position, end: position } };
          content = applyDiff(content, diff);
          await handle!.publishDiffs([diff], {
            eventId: `recovered-${index}`, createdAt: 100 + index, draftContent: content,
          });
        }
      });
      await waitFor(() => expect(publishedEvents).toHaveLength(1));
      const queued = await listDiffOutboxEvents(scope);
      expect(queued).toHaveLength(8);
      expect(content).toBe(expected);
      first.unmount();
      await waitFor(async () => expect(await hasDiffOutboxWriterLease({ ...scope, ownerId: clientId })).toBe(false));
      if (takeover) {
        // A crashed/reloaded page can leave its old writer lease alive.
        await acquireDiffOutboxWriterLease({ ...scope, ownerId: clientId, leaseDurationMs: 15_000 });
      }
      content = base;
      const restored = jest.fn((draft: string) => { content = draft; });
      const options = createOptions({ clientId: "reloaded-client", isOffline: false, editor, onRestoreBranchDraft: restored });
      const second = render(<HookHarness options={options} onUpdate={(value) => { handle = value; }} />);
      let takingOver: Promise<void> | undefined;
      if (takeover) {
        await waitFor(() => expect(handle?.syncState.mode).toBe("observer"));
        expect(restored).not.toHaveBeenCalled();
        await act(async () => { takingOver = handle!.takeOverEditing(); });
      }
      await waitFor(() => expect(restored).toHaveBeenCalledWith(expected));
      expect(content).toBe(expected);
      // A restore callback identity change must not discard represented event IDs.
      second.rerender(<HookHarness options={{ ...options, onRestoreBranchDraft: (draft) => { content = draft; } }}
        onUpdate={(value) => { handle = value; }} />);
      await act(async () => { release(); await takingOver; await handle!.flushPendingDiffs(); });
      await waitFor(() => expect(handle?.syncState.mode).toBe("synced"));
      expect(await listDiffOutboxEvents(scope)).toEqual([]);
      // A later account/client transport refresh must also retain those identities.
      second.rerender(<HookHarness options={{ ...options, clientId: "refreshed-client", isOffline: true }}
        onUpdate={(value) => { handle = value; }} />);
      await waitFor(() => expect(handle?.syncState.mode).toBe("offline"));
      const echo = queued.map((record, index) => ({ ...record.event, seq: 8 + index, snapshotId: 9 + index }));
      await act(async () => {
        channels.get("refreshed-client")!.emit({ events: [...echo, {
          ...foreignEvent(), seq: 16,
          ops: [{ type: "insert", start: expected.length, end: expected.length, text: " FOREIGN" }],
        }], facts: [] });
      });
      await waitFor(() => expect(editor.addDiffs).toHaveBeenCalled());
      expect(content).toBe(`${expected} FOREIGN`);
      expect(editor.addDiffs.mock.calls.flatMap(([diffs]) => diffs)).toHaveLength(1);
      await act(async () => {
        await handle!.publishDiffs([createInsertDiff("next")], {
          eventId: "next-after-recovery", createdAt: 200, draftContent: `next${content}`,
        });
      });
      expect((await listDiffOutboxEvents(scope))[0].event.metadata?.followsSeq).toBe(16);
      // Recovery dedupe must not suppress a different writer while local edits wait.
      await act(async () => {
        channels.get("refreshed-client")!.emit({ events: [{ ...foreignEvent(), eventId: "conflicting-foreign", seq: 17 }], facts: [] });
      });
      await waitFor(() => expect(handle?.syncState.mode).toBe("blocked"));
      expect(content).toBe(`${expected} FOREIGN`);
    } finally {
      release();
    }
  });

  it("replays a response-lost immutable event after reload and clears its restored draft on a duplicate receipt", async () => {
    const restoredDraft = jest.fn();
    let firstHandle: HookHandle | null = null;
    loseResponse = true;
    const firstRender = render(
      <HookHarness
        options={createOptions({ isOffline: false, onRestoreBranchDraft: restoredDraft })}
        onUpdate={(value) => {
          firstHandle = value;
        }}
      />,
    );

    await waitFor(() => expect(firstHandle?.syncState.mode).toBe("synced"));
    await act(async () => {
      await firstHandle!.publishDiffs([createInsertDiff("local")], {
        eventId: "event-1",
        createdAt: 1_725_000_000_000,
        draftContent: "local draft",
      });
    });

    await waitFor(async () => {
      expect(publishedEvents).toHaveLength(1);
      await expect(listDiffOutboxEvents(scope)).resolves.toEqual([
        expect.objectContaining({ eventId: "event-1", status: "retry", retryCount: 1 }),
      ]);
    });
    const durableEvent = (await listDiffOutboxEvents(scope))[0]!.event;
    expect(await readDiffOutboxBranchDraft(scope)).toEqual(
      expect.objectContaining({ content: "local draft" }),
    );

    firstRender.unmount();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await resetNulldownDatabaseForTests({ deleteDatabase: false });
    loseResponse = false;
    let reloadedHandle: HookHandle | null = null;
    render(
      <HookHarness
        options={createOptions({ isOffline: false, onRestoreBranchDraft: restoredDraft })}
        onUpdate={(value) => {
          reloadedHandle = value;
        }}
      />,
    );

    await waitFor(() => expect(reloadedHandle?.syncState.mode).toBe("synced"));
    expect(restoredDraft).toHaveBeenCalledWith("local draft");
    expect(publishedEvents).toEqual([durableEvent, durableEvent]);
    expect(await listDiffOutboxEvents(scope)).toEqual([]);
    await expect(readDiffOutboxBranchDraft(scope)).resolves.toBeNull();
  });

  it("keeps a second tab read-only until it explicitly takes over the branch writer lease", async () => {
    let writer: HookHandle | null = null;
    let observer: HookHandle | null = null;
    render(
      <HookHarness
        options={createOptions()}
        onUpdate={(value) => {
          writer = value;
        }}
      />,
    );
    render(
      <HookHarness
        options={createOptions({ clientId: "client-2" })}
        onUpdate={(value) => {
          observer = value;
        }}
      />,
    );

    await waitFor(() => expect(writer?.syncState.canEdit).toBe(true));
    await waitFor(() => expect(observer?.syncState).toEqual(
      expect.objectContaining({ mode: "observer", canEdit: false }),
    ));

    await act(async () => {
      await observer!.takeOverEditing();
    });

    expect((observer as HookHandle | null)?.syncState).toEqual(
      expect.objectContaining({ mode: "offline", canEdit: true }),
    );
  });

  it("applies an accepted writer event in an observer tab", async () => {
    const editor = { addDiffs: jest.fn() };
    render(
      <HookHarness options={createOptions({ editor })} onUpdate={() => {}} />,
    );
    render(
      <HookHarness
        options={createOptions({ clientId: "client-2", editor })}
        onUpdate={() => {}}
      />,
    );

    await waitFor(() => expect(channels.get("client-2")).toBeDefined());
    channels.get("client-2")!.emit({
      events: [
        {
          ...foreignEvent(),
          eventId: "writer-event",
          sourceClientId: clientId,
        },
      ],
      facts: [],
    });

    await waitFor(() => expect(editor.addDiffs).toHaveBeenCalled());
  });

  it("does not let a former writer discard the active writer's durable edits", async () => {
    let formerWriter: HookHandle | null = null;
    let activeWriter: HookHandle | null = null;
    render(
      <HookHarness
        options={createOptions()}
        onUpdate={(value) => {
          formerWriter = value;
        }}
      />,
    );
    render(
      <HookHarness
        options={createOptions({ clientId: "client-2" })}
        onUpdate={(value) => {
          activeWriter = value;
        }}
      />,
    );

    await waitFor(() => expect(formerWriter?.syncState.mode).toBe("offline"));
    await act(async () => {
      await formerWriter!.publishDiffs([createInsertDiff("local")], {
        eventId: "event-1",
        createdAt: 1_725_000_000_000,
        draftContent: "local draft",
      });
      await activeWriter!.takeOverEditing();
    });

    await act(async () => {
      await expect(formerWriter!.discardSyncConflict()).rejects.toThrow(
        "This branch is being edited in another tab.",
      );
    });
    await expect(listDiffOutboxEvents(scope)).resolves.toEqual([
      expect.objectContaining({ eventId: "event-1" }),
    ]);
    await expect(readDiffOutboxBranchDraft(scope)).resolves.toEqual(
      expect.objectContaining({ content: "local draft" }),
    );
  });

  it("restores the durable branch draft before takeover can drain it", async () => {
    const restoredDraft = jest.fn();
    let writer: HookHandle | null = null;
    let observer: HookHandle | null = null;
    render(
      <HookHarness
        options={createOptions()}
        onUpdate={(value) => {
          writer = value;
        }}
      />,
    );
    render(
      <HookHarness
        options={createOptions({ clientId: "client-2", onRestoreBranchDraft: restoredDraft })}
        onUpdate={(value) => {
          observer = value;
        }}
      />,
    );

    await waitFor(() => expect(writer?.syncState.mode).toBe("offline"));
    await act(async () => {
      await writer!.publishDiffs([createInsertDiff("local")], {
        eventId: "event-1",
        createdAt: 1_725_000_000_000,
        draftContent: "local draft",
      });
      await observer!.takeOverEditing();
    });

    expect(restoredDraft).toHaveBeenCalledWith("local draft");
  });

  it("persists an offline writer edit before resolving publication", async () => {
    let handle: HookHandle | null = null;
    render(
      <HookHarness
        options={createOptions()}
        onUpdate={(value) => {
          handle = value;
        }}
      />,
    );

    await waitFor(() => expect(handle?.syncState.mode).toBe("offline"));
    await act(async () => {
      await expect(
        handle!.publishDiffs([createInsertDiff("local")], {
          eventId: "event-offline-durable",
          createdAt: 1_725_000_000_000,
          draftContent: "local draft",
        }),
      ).resolves.toEqual([]);
    });
    await expect(listDiffOutboxEvents(scope)).resolves.toEqual([
      expect.objectContaining({ eventId: "event-offline-durable", status: "queued" }),
    ]);
    await expect(readDiffOutboxBranchDraft(scope)).resolves.toEqual(
      expect.objectContaining({ content: "local draft" }),
    );
  });

  it("refuses branch publishing after a displaced writer cannot persist its edit", async () => {
    let writer: HookHandle | null = null;
    let observer: HookHandle | null = null;
    render(
      <HookHarness
        options={createOptions()}
        onUpdate={(value) => {
          writer = value;
        }}
      />,
    );
    render(
      <HookHarness
        options={createOptions({ clientId: "client-2" })}
        onUpdate={(value) => {
          observer = value;
        }}
      />,
    );

    await waitFor(() => expect(writer?.syncState.mode).toBe("offline"));
    await act(async () => {
      await observer!.takeOverEditing();
      await expect(
        writer!.publishDiffs([createInsertDiff("local")], {
          eventId: "event-lost-lease",
          createdAt: 1_725_000_000_000,
          draftContent: "local draft",
        }),
      ).rejects.toThrow("writer lease is no longer active");
    });

    await expect(writer!.flushPendingDiffs()).rejects.toThrow(
      "Durable diff storage is unavailable for this branch.",
    );
    expect(writer!.syncState).toEqual(
      expect.objectContaining({ mode: "blocked", canEdit: false }),
    );
    await act(async () => {
      await expect(
        writer!.publishDiffs([createInsertDiff("second local")], {
          eventId: "event-after-lease-loss",
          createdAt: 1_725_000_000_001,
          draftContent: "second local draft",
        }),
      ).rejects.toThrow("This branch is open for editing in another tab.");
    });
    await expect(listDiffOutboxEvents(scope)).resolves.toEqual([]);
  });

  it("blocks the first pending event when a foreign event arrives", async () => {
    let handle: HookHandle | null = null;
    render(
      <HookHarness
        options={createOptions()}
        onUpdate={(value) => {
          handle = value;
        }}
      />,
    );

    await waitFor(() => expect(handle?.syncState.mode).toBe("offline"));
    await act(async () => {
      await handle!.publishDiffs([createInsertDiff("local")], {
        eventId: "event-1",
        createdAt: 1_725_000_000_000,
        draftContent: "local draft",
      });
    });
    channels.get(clientId)!.emit({ events: [foreignEvent()], facts: [] });

    await waitFor(() => expect(handle?.syncState).toEqual(
      expect.objectContaining({ mode: "blocked", pendingCount: 1, canEdit: true }),
    ));
    await expect(listDiffOutboxEvents(scope)).resolves.toEqual([
      expect.objectContaining({ eventId: "event-1", status: "blocked" }),
    ]);
  });
});

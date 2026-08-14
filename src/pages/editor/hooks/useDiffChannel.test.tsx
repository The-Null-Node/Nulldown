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

const publishEvent = async (event: DropDiffEvent): Promise<DropDiffAppendResponse> => {
  publishedEvents.push(event);
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

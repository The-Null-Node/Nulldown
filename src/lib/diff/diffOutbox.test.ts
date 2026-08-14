import { IDBKeyRange as fakeIDBKeyRange, indexedDB } from "fake-indexeddb";
import type { DropDiffEvent, DropDiffEventMetadata, DropDiffOp } from "../../../shared/drop/diff";
import {
  acquireDiffOutboxWriterLease,
  listDiffOutboxEvents,
} from "./diffOutboxStore";
import {
  DIFF_OUTBOX_RETRY_ERROR_CLASSIFICATIONS,
  classifyDiffOutboxError,
  createDiffOutbox,
  type DiffOutboxTransport,
  type SubmitDiffOutboxEventInput,
} from "./diffOutbox";
import { resetNulldownDatabaseForTests } from "../indexedDb";

const scope = { rootId: "root-1", branchId: "branch-1" };

const ensureWindowWithIndexedDb = () => {
  const currentWindow = (globalThis as { window?: unknown }).window as
    | { indexedDB?: IDBFactory }
    | undefined;
  if (!currentWindow) {
    Object.defineProperty(globalThis, "window", {
      value: { indexedDB },
      configurable: true,
    });
  } else {
    currentWindow.indexedDB = indexedDB;
  }
  Object.defineProperty(globalThis, "IDBKeyRange", {
    value: fakeIDBKeyRange,
    configurable: true,
  });
};

const acknowledgement = (eventId: string, status: "accepted" | "duplicate" = "accepted") => ({
  accepted: status === "accepted" ? 1 : 0,
  deduplicated: status === "duplicate" ? 1 : 0,
  branchId: scope.branchId,
  snapshotId: 5,
  totalStored: 5,
  acknowledgements: [{ eventId, seq: 4, snapshotId: 5, status }],
});

const eventInput = (
  eventId: string,
  text = eventId,
): SubmitDiffOutboxEventInput => ({
  ...scope,
  clientId: "client-1",
  eventId,
  createdAt: 1_725_000_000_000,
  branchHeadSeq: 4,
  ops: [{ type: "insert", start: 0, end: 0, text }],
});

const createOutbox = (transport: DiffOutboxTransport) =>
  createDiffOutbox({
    transport,
    createEventId: () => "generated-event",
    now: () => 1_725_000_000_100,
  });

describe("diff outbox", () => {
  beforeEach(async () => {
    ensureWindowWithIndexedDb();
    await resetNulldownDatabaseForTests();
  });

  afterEach(async () => {
    await resetNulldownDatabaseForTests();
  });

  it("prepares an immutable event and persists it before transport", async () => {
    const ops: DropDiffOp[] = [{ type: "insert", start: 0, end: 0, text: "first" }];
    const metadata: DropDiffEventMetadata = { args: { source: "editor" } };
    let sentEvent: DropDiffEvent | undefined;
    let persistedBeforeSend = false;
    const outbox = createOutbox(async ({ event }) => {
      sentEvent = event;
      const records = await listDiffOutboxEvents(scope);
      persistedBeforeSend = records.length === 1 && records[0]?.event.eventId === event.eventId;
      return acknowledgement(event.eventId);
    });

    const prepared = outbox.prepare({
      ...scope,
      clientId: "client-1",
      branchHeadSeq: 4,
      ops,
      metadata,
    });
    expect(prepared).toEqual(
      expect.objectContaining({
        eventId: "generated-event",
        createdAt: 1_725_000_000_100,
        metadata: { args: { source: "editor" }, followsSeq: 4 },
      }),
    );
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.ops)).toBe(true);

    const result = await outbox.submit({
      ...scope,
      clientId: "client-1",
      branchHeadSeq: 4,
      ops,
      metadata,
    });
    ops[0]!.text = "changed after prepare";
    metadata.args!.source = "changed after prepare";

    expect(result).toEqual(expect.objectContaining({ status: "drained", sentCount: 1 }));
    expect(persistedBeforeSend).toBe(true);
    expect(sentEvent).toEqual(
      expect.objectContaining({
        ops: [{ type: "insert", start: 0, end: 0, text: "first" }],
        metadata: { args: { source: "editor" }, followsSeq: 4 },
      }),
    );
    await expect(listDiffOutboxEvents(scope)).resolves.toEqual([]);
  });

  it("drains one event at a time in FIFO order for a scope", async () => {
    const sent: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    let releaseFirst: () => void = () => undefined;
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted: () => void = () => undefined;
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const outbox = createOutbox(async ({ event }) => {
      sent.push(event.eventId);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (event.eventId === "event-1") {
        firstStarted();
        await firstReleased;
      }
      inFlight -= 1;
      return acknowledgement(event.eventId);
    });

    await outbox.enqueue(eventInput("event-1"));
    await outbox.enqueue(eventInput("event-2"));
    const firstDrain = outbox.drain(scope);
    await firstStartedPromise;
    const concurrentDrain = outbox.drain(scope);

    expect(sent).toEqual(["event-1"]);
    releaseFirst();
    await expect(Promise.all([firstDrain, concurrentDrain])).resolves.toEqual([
      expect.objectContaining({ status: "drained", sentCount: 2 }),
      expect.objectContaining({ status: "drained", sentCount: 2 }),
    ]);
    expect(sent).toEqual(["event-1", "event-2"]);
    expect(maxInFlight).toBe(1);
  });

  it("replays the exact durable event as a duplicate after response loss and service recreation", async () => {
    let acceptedBeforeResponseLoss: DropDiffEvent | undefined;
    const firstOutbox = createOutbox(async ({ event }) => {
      acceptedBeforeResponseLoss = event;
      throw new Error("response lost after acceptance");
    });

    await expect(firstOutbox.submit(eventInput("event-1"))).resolves.toEqual(
      expect.objectContaining({ status: "retry", retryClassification: "transport" }),
    );
    const retryRecord = (await listDiffOutboxEvents(scope))[0];
    expect(retryRecord).toEqual(
      expect.objectContaining({ eventId: "event-1", status: "retry", retryCount: 1 }),
    );

    await resetNulldownDatabaseForTests({ deleteDatabase: false });

    let replayedEvent: DropDiffEvent | undefined;
    const recreatedOutbox = createOutbox(async ({ event }) => {
      replayedEvent = event;
      return acknowledgement(event.eventId, "duplicate");
    });
    await expect(recreatedOutbox.drain(scope)).resolves.toEqual(
      expect.objectContaining({ status: "drained", sentCount: 1 }),
    );

    expect(replayedEvent).toEqual(acceptedBeforeResponseLoss);
    await expect(listDiffOutboxEvents(scope)).resolves.toEqual([]);
  });

  it("blocks a stale predecessor and leaves later events unsent", async () => {
    const sent: string[] = [];
    const outbox = createOutbox(async ({ event }) => {
      sent.push(event.eventId);
      throw { status: 409, code: "diff_predecessor_mismatch" };
    });

    await outbox.enqueue(eventInput("event-1"));
    await outbox.enqueue(eventInput("event-2"));

    await expect(outbox.drain(scope)).resolves.toEqual(
      expect.objectContaining({ status: "blocked", sentCount: 0 }),
    );
    expect(sent).toEqual(["event-1"]);
    await expect(listDiffOutboxEvents(scope)).resolves.toEqual([
      expect.objectContaining({ eventId: "event-1", status: "blocked" }),
      expect.objectContaining({ eventId: "event-2", status: "queued" }),
    ]);
  });

  it("blocks a persisted sequence conflict and leaves later events unsent", async () => {
    const sent: string[] = [];
    const outbox = createOutbox(async ({ event }) => {
      sent.push(event.eventId);
      throw { status: 409, code: "diff_predecessor_mismatch" };
    });

    await outbox.enqueue(eventInput("event-1"));
    await outbox.enqueue(eventInput("event-2"));

    await expect(outbox.drain(scope)).resolves.toEqual(
      expect.objectContaining({ status: "blocked", sentCount: 0 }),
    );
    expect(sent).toEqual(["event-1"]);
    await expect(listDiffOutboxEvents(scope)).resolves.toEqual([
      expect.objectContaining({ eventId: "event-1", status: "blocked" }),
      expect.objectContaining({ eventId: "event-2", status: "queued" }),
    ]);
  });

  it("marks transport failures for retry and leaves later events unsent", async () => {
    const sent: string[] = [];
    const outbox = createOutbox(async ({ event }) => {
      sent.push(event.eventId);
      throw new Error("offline");
    });

    await outbox.enqueue(eventInput("event-1"));
    await outbox.enqueue(eventInput("event-2"));

    await expect(outbox.drain(scope)).resolves.toEqual(
      expect.objectContaining({
        status: "retry",
        sentCount: 0,
        retryClassification: "transport",
      }),
    );
    expect(sent).toEqual(["event-1"]);
    await expect(listDiffOutboxEvents(scope)).resolves.toEqual([
      expect.objectContaining({ eventId: "event-1", status: "retry", retryCount: 1 }),
      expect.objectContaining({ eventId: "event-2", status: "queued" }),
    ]);
  });

  it("retains an event when the response acknowledges a different identity", async () => {
    const outbox = createOutbox(async () => acknowledgement("other-event"));

    await outbox.enqueue(eventInput("event-1"));

    await expect(outbox.drain(scope)).resolves.toEqual(
      expect.objectContaining({
        status: "retry",
        retryClassification: "unknown",
      }),
    );
    await expect(listDiffOutboxEvents(scope)).resolves.toEqual([
      expect.objectContaining({ eventId: "event-1", status: "retry", retryCount: 1 }),
    ]);
  });

  it("retains an event when a receipt names another branch", async () => {
    const outbox = createOutbox(async ({ event }) => ({
      ...acknowledgement(event.eventId),
      branchId: "another-branch",
    }));

    await outbox.enqueue(eventInput("event-1"));

    await expect(outbox.drain(scope)).resolves.toEqual(
      expect.objectContaining({ status: "retry", retryClassification: "unknown" }),
    );
    await expect(listDiffOutboxEvents(scope)).resolves.toEqual([
      expect.objectContaining({ eventId: "event-1", status: "retry" }),
    ]);
  });

  it("retains an event when a receipt repeats its acknowledgement", async () => {
    const outbox = createOutbox(async ({ event }) => {
      const receipt = acknowledgement(event.eventId);
      return {
        ...receipt,
        acknowledgements: [...receipt.acknowledgements, receipt.acknowledgements[0]!],
      };
    });

    await outbox.enqueue(eventInput("event-1"));

    await expect(outbox.drain(scope)).resolves.toEqual(
      expect.objectContaining({ status: "retry", retryClassification: "unknown" }),
    );
    await expect(listDiffOutboxEvents(scope)).resolves.toEqual([
      expect.objectContaining({ eventId: "event-1", status: "retry" }),
    ]);
  });

  it("does not send when the writer lease is no longer active", async () => {
    let sent = false;
    const outbox = createDiffOutbox({
      transport: async ({ event }) => {
        sent = true;
        return acknowledgement(event.eventId);
      },
      canDrain: async () => false,
    });
    await outbox.enqueue(eventInput("event-1"));

    await expect(outbox.drain(scope)).resolves.toEqual(
      expect.objectContaining({ status: "retry", sentCount: 0 }),
    );
    expect(sent).toBe(false);
  });

  it("does not acknowledge an in-flight event after another tab takes over", async () => {
    await acquireDiffOutboxWriterLease({
      ...scope,
      ownerId: "writer-1",
      leaseDurationMs: 100,
      now: Date.now(),
    });
    const outbox = createDiffOutbox({
      transport: async ({ event }) => {
        await acquireDiffOutboxWriterLease({
          ...scope,
          ownerId: "writer-2",
          leaseDurationMs: 100,
          force: true,
          now: Date.now(),
        });
        return acknowledgement(event.eventId);
      },
      canDrain: async () => true,
      writerId: "writer-1",
    });
    await outbox.enqueue({ ...eventInput("event-1"), ownerId: "writer-1" });

    await expect(outbox.drain(scope)).resolves.toEqual(
      expect.objectContaining({ status: "retry", sentCount: 0 }),
    );
    await expect(listDiffOutboxEvents(scope)).resolves.toEqual([
      expect.objectContaining({ eventId: "event-1", status: "queued" }),
    ]);
  });

  it("classifies terminal, transient, unknown, and transport errors structurally", () => {
    expect(DIFF_OUTBOX_RETRY_ERROR_CLASSIFICATIONS).toEqual([
      "transport",
      "unknown",
      "transient",
    ]);
    expect(
      classifyDiffOutboxError({ status: 409, code: "diff_predecessor_mismatch" }),
    ).toBe("blocked");
    expect(classifyDiffOutboxError({ status: 400 })).toBe("blocked");
    expect(classifyDiffOutboxError({ status: 409, code: "branch_lock_timeout" })).toBe(
      "transient",
    );
    expect(
      classifyDiffOutboxError({
        status: 409,
        code: "branch_lock_lost_before_commit",
      }),
    ).toBe("transient");
    expect(classifyDiffOutboxError({ status: 503 })).toBe("transient");
    expect(classifyDiffOutboxError({ code: "unexpected_response" })).toBe("unknown");
    expect(classifyDiffOutboxError(new Error("offline"))).toBe("transport");
  });
});

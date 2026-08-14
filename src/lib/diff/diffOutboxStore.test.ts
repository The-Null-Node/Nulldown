import { IDBKeyRange as fakeIDBKeyRange, indexedDB } from "fake-indexeddb";
import type { DropDiffEvent } from "../../../shared/drop/diff";
import {
  NULLDOWN_DIFF_OUTBOX_BRANCH_STATE_STORE,
  NULLDOWN_DIFF_OUTBOX_EVENTS_STORE,
  getKvValue,
  openNulldownDatabase,
  resetNulldownDatabaseForTests,
} from "../indexedDb";
import {
  acknowledgeDiffOutboxEvent,
  acquireDiffOutboxWriterLease,
  blockDiffOutboxEventForWriter,
  clearDiffOutboxBranchDraft,
  clearDiffOutboxBranchDraftIfEmptyForWriter,
  discardDiffOutboxScopeForWriter,
  enqueueDiffOutboxEvent,
  hasDiffOutboxWriterLease,
  listDiffOutboxEvents,
  persistDiffOutboxBranchDraft,
  readDiffOutboxBranchDraft,
  releaseDiffOutboxWriterLease,
  renewDiffOutboxWriterLease,
  updateDiffOutboxEventStatus,
} from "./diffOutboxStore";

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

const createEvent = (eventId: string, text = eventId): DropDiffEvent => ({
  eventId,
  seq: -1,
  dropId: scope.rootId,
  sourceClientId: "client-1",
  createdAt: 1_725_000_000_000,
  ops: [{ type: "insert", start: 0, end: 0, text }],
});

const deleteLegacyDatabase = async () => {
  const request = indexedDB.deleteDatabase("nulldown");
  await new Promise<void>((resolve, reject) => {
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
};

describe("diff outbox store", () => {
  beforeEach(async () => {
    ensureWindowWithIndexedDb();
    await resetNulldownDatabaseForTests();
  });

  afterEach(async () => {
    await resetNulldownDatabaseForTests();
  });

  it("lists enqueued events in FIFO order after the database is reopened", async () => {
    await enqueueDiffOutboxEvent({ ...scope, event: createEvent("event-1"), now: 10 });
    await enqueueDiffOutboxEvent({ ...scope, event: createEvent("event-2"), now: 11 });

    await resetNulldownDatabaseForTests({ deleteDatabase: false });

    const restored = await listDiffOutboxEvents(scope);
    expect(restored.map((record) => record.eventId)).toEqual(["event-1", "event-2"]);
    expect(restored.map((record) => record.queueOrder)).toEqual([0, 1]);
  });

  it("restores a branch draft after the database is reopened", async () => {
    await persistDiffOutboxBranchDraft({
      ...scope,
      content: "Unpublished branch content",
      updatedAt: 10,
    });

    await resetNulldownDatabaseForTests({ deleteDatabase: false });

    await expect(readDiffOutboxBranchDraft(scope)).resolves.toEqual({
      version: 1,
      content: "Unpublished branch content",
      updatedAt: 10,
    });
  });

  it("atomically persists a branch draft while enqueueing its event", async () => {
    await enqueueDiffOutboxEvent({
      ...scope,
      event: createEvent("event-1"),
      draft: { content: "Current branch content", updatedAt: 11 },
      now: 10,
    });

    await expect(listDiffOutboxEvents(scope)).resolves.toEqual([
      expect.objectContaining({ eventId: "event-1", queueOrder: 0 }),
    ]);
    await expect(readDiffOutboxBranchDraft(scope)).resolves.toEqual({
      version: 1,
      content: "Current branch content",
      updatedAt: 11,
    });
  });

  it("clears a branch draft without changing queued events", async () => {
    await enqueueDiffOutboxEvent({ ...scope, event: createEvent("event-1"), now: 10 });
    await persistDiffOutboxBranchDraft({ ...scope, content: "Current branch content", now: 11 });

    await expect(clearDiffOutboxBranchDraft(scope)).resolves.toBe(true);
    await expect(readDiffOutboxBranchDraft(scope)).resolves.toBeNull();
    await expect(listDiffOutboxEvents(scope)).resolves.toEqual([
      expect.objectContaining({ eventId: "event-1", queueOrder: 0, enqueuedAt: 10 }),
    ]);
  });

  it("fails closed for malformed branch draft state", async () => {
    const database = await openNulldownDatabase();
    const transaction = database.transaction(
      NULLDOWN_DIFF_OUTBOX_BRANCH_STATE_STORE,
      "readwrite",
    );
    transaction.objectStore(NULLDOWN_DIFF_OUTBOX_BRANCH_STATE_STORE).put({
      ...scope,
      nextQueueOrder: 0,
      draft: { version: 1, content: 42, updatedAt: 10 },
    });
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });

    await expect(readDiffOutboxBranchDraft(scope)).rejects.toThrow(
      "Invalid diff outbox branch draft.",
    );
  });

  it("acknowledges only the matching event identity", async () => {
    await enqueueDiffOutboxEvent({ ...scope, event: createEvent("event-1") });
    await enqueueDiffOutboxEvent({ ...scope, event: createEvent("event-2") });
    await enqueueDiffOutboxEvent({
      rootId: scope.rootId,
      branchId: "branch-2",
      event: { ...createEvent("event-1"), sourceClientId: "client-2" },
    });

    await expect(
      acknowledgeDiffOutboxEvent({ ...scope, eventId: "event-1" }),
    ).resolves.toBe(true);
    await expect(listDiffOutboxEvents(scope)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ eventId: "event-2" })]),
    );
    await expect(
      listDiffOutboxEvents({ rootId: scope.rootId, branchId: "branch-2" }),
    ).resolves.toEqual([expect.objectContaining({ eventId: "event-1" })]);
  });

  it("rejects an immutable duplicate event identity with different data", async () => {
    await enqueueDiffOutboxEvent({ ...scope, event: createEvent("event-1", "first") });

    await expect(
      enqueueDiffOutboxEvent({ ...scope, event: createEvent("event-1", "second") }),
    ).rejects.toThrow("already exists with different data");
    await expect(listDiffOutboxEvents(scope)).resolves.toEqual([
      expect.objectContaining({
        eventId: "event-1",
        event: expect.objectContaining({ ops: [{ type: "insert", start: 0, end: 0, text: "first" }] }),
      }),
    ]);
  });

  it("persists retry and blocked event state without changing the envelope", async () => {
    const event = createEvent("event-1");
    await enqueueDiffOutboxEvent({ ...scope, event, now: 10 });

    await expect(
      updateDiffOutboxEventStatus({ ...scope, eventId: event.eventId, status: "retry", now: 20 }),
    ).resolves.toEqual(expect.objectContaining({ status: "retry", retryCount: 1 }));
    await expect(
      updateDiffOutboxEventStatus({ ...scope, eventId: event.eventId, status: "blocked", now: 30 }),
    ).resolves.toEqual(expect.objectContaining({ status: "blocked", retryCount: 1 }));
    await expect(listDiffOutboxEvents(scope)).resolves.toEqual([
      expect.objectContaining({ event, status: "blocked", retryCount: 1, updatedAt: 30 }),
    ]);
  });

  it("allows lease takeover only after expiration", async () => {
    await expect(
      acquireDiffOutboxWriterLease({ ...scope, ownerId: "writer-1", leaseDurationMs: 100, now: 10 }),
    ).resolves.toEqual(expect.objectContaining({ ownerId: "writer-1", expiresAt: 110 }));
    await expect(
      renewDiffOutboxWriterLease({ ...scope, ownerId: "writer-1", leaseDurationMs: 100, now: 20 }),
    ).resolves.toEqual(expect.objectContaining({ expiresAt: 120 }));
    await expect(
      acquireDiffOutboxWriterLease({ ...scope, ownerId: "writer-2", leaseDurationMs: 100, now: 119 }),
    ).resolves.toBeNull();
    await expect(
      acquireDiffOutboxWriterLease({ ...scope, ownerId: "writer-2", leaseDurationMs: 100, now: 120 }),
    ).resolves.toEqual(expect.objectContaining({ ownerId: "writer-2", expiresAt: 220 }));
    await expect(
      releaseDiffOutboxWriterLease({ ...scope, ownerId: "writer-1" }),
    ).resolves.toBe(false);
    await expect(
      releaseDiffOutboxWriterLease({ ...scope, ownerId: "writer-2" }),
    ).resolves.toBe(true);
  });

  it("allows an explicit writer takeover before the prior lease expires", async () => {
    await acquireDiffOutboxWriterLease({
      ...scope,
      ownerId: "writer-1",
      leaseDurationMs: 100,
      now: 10,
    });

    await expect(
      acquireDiffOutboxWriterLease({
        ...scope,
        ownerId: "writer-2",
        leaseDurationMs: 100,
        force: true,
        now: 20,
      }),
    ).resolves.toEqual(expect.objectContaining({ ownerId: "writer-2", expiresAt: 120 }));
    await expect(
      renewDiffOutboxWriterLease({
        ...scope,
        ownerId: "writer-1",
        leaseDurationMs: 100,
        now: 21,
      }),
    ).resolves.toBeNull();
  });

  it("does not discard a new writer's branch state after takeover", async () => {
    await enqueueDiffOutboxEvent({ ...scope, event: createEvent("event-1"), now: 10 });
    await persistDiffOutboxBranchDraft({ ...scope, content: "local draft", now: 10 });
    await acquireDiffOutboxWriterLease({
      ...scope,
      ownerId: "writer-1",
      leaseDurationMs: 100,
      now: 10,
    });
    await acquireDiffOutboxWriterLease({
      ...scope,
      ownerId: "writer-2",
      leaseDurationMs: 100,
      force: true,
      now: 20,
    });

    await expect(
      discardDiffOutboxScopeForWriter({ ...scope, ownerId: "writer-1", now: 20 }),
    ).resolves.toBe(false);
    await expect(listDiffOutboxEvents(scope)).resolves.toEqual([
      expect.objectContaining({ eventId: "event-1" }),
    ]);
    await expect(readDiffOutboxBranchDraft(scope)).resolves.toEqual(
      expect.objectContaining({ content: "local draft" }),
    );
  });

  it("does not let a former writer block the active writer's event", async () => {
    await enqueueDiffOutboxEvent({ ...scope, event: createEvent("event-1"), now: 10 });
    await acquireDiffOutboxWriterLease({
      ...scope,
      ownerId: "writer-1",
      leaseDurationMs: 100,
      now: 10,
    });
    await acquireDiffOutboxWriterLease({
      ...scope,
      ownerId: "writer-2",
      leaseDurationMs: 100,
      force: true,
      now: 20,
    });

    await expect(
      blockDiffOutboxEventForWriter({
        ...scope,
        eventId: "event-1",
        ownerId: "writer-1",
        now: 20,
      }),
    ).resolves.toBeNull();
    await expect(listDiffOutboxEvents(scope)).resolves.toEqual([
      expect.objectContaining({ eventId: "event-1", status: "queued" }),
    ]);
  });

  it("does not clear a draft while a queued event remains", async () => {
    await acquireDiffOutboxWriterLease({
      ...scope,
      ownerId: "writer-1",
      leaseDurationMs: 100,
      now: 10,
    });
    await enqueueDiffOutboxEvent({
      ...scope,
      event: createEvent("event-1"),
      draft: { content: "latest local text", updatedAt: 11 },
      ownerId: "writer-1",
      now: 11,
    });

    await expect(
      clearDiffOutboxBranchDraftIfEmptyForWriter({
        ...scope,
        ownerId: "writer-1",
        now: 12,
      }),
    ).resolves.toBe(false);
    await expect(readDiffOutboxBranchDraft(scope)).resolves.toEqual(
      expect.objectContaining({ content: "latest local text" }),
    );
  });

  it("rejects new events from a writer displaced by takeover", async () => {
    await acquireDiffOutboxWriterLease({
      ...scope,
      ownerId: "writer-1",
      leaseDurationMs: 100,
      now: 10,
    });
    await acquireDiffOutboxWriterLease({
      ...scope,
      ownerId: "writer-2",
      leaseDurationMs: 100,
      force: true,
      now: 20,
    });

    await expect(
      enqueueDiffOutboxEvent({
        ...scope,
        event: createEvent("event-1"),
        ownerId: "writer-1",
        now: 20,
      }),
    ).rejects.toThrow("writer lease is no longer active");
    await expect(
      hasDiffOutboxWriterLease({ ...scope, ownerId: "writer-1", now: 20 }),
    ).resolves.toBe(false);
  });

  it("upgrades a version-one database without removing existing stores", async () => {
    await deleteLegacyDatabase();
    const request = indexedDB.open("nulldown", 1);
    await new Promise<void>((resolve, reject) => {
      request.onupgradeneeded = () => {
        request.result.createObjectStore("kv").put("legacy-value", "legacy-key");
        request.result.createObjectStore("drops", { keyPath: "id" });
      };
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
      request.onerror = () => reject(request.error);
    });

    const database = await openNulldownDatabase();
    expect(database.objectStoreNames.contains("kv")).toBe(true);
    expect(database.objectStoreNames.contains("drops")).toBe(true);
    expect(database.objectStoreNames.contains(NULLDOWN_DIFF_OUTBOX_EVENTS_STORE)).toBe(true);
    expect(database.objectStoreNames.contains(NULLDOWN_DIFF_OUTBOX_BRANCH_STATE_STORE)).toBe(true);
    await expect(getKvValue("legacy-key")).resolves.toBe("legacy-value");
  });
});

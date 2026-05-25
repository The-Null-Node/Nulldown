/*
Snapshotter keeps a bounded in-memory window of recent editor states. The browser uses
it to build draft packs and to correlate rendered output with the text snapshot that
produced it, without persisting every intermediate keystroke forever.
*/

import MaxPriorityQueue from "./priorityQueue";
import type { Snapshot, SnapshotDiff, SnapshotId } from "./types";

type SnapshotUpdate = Partial<
  Pick<Snapshot, "content" | "renderedMarkdown" | "status" | "baseSnapshotId">
>;

export default class Snapshotter {
  private readonly snapshots = new Map<SnapshotId, Snapshot>();

  private queue: MaxPriorityQueue<Snapshot>;
  private nextId = 1;
  private _maxDepth = 3;
  private readonly registered = new Set<SnapshotId>();

  private readonly compareSnapshots = (a: Snapshot, b: Snapshot) => a.id - b.id;

  constructor(maxDepth = 3) {
    this._maxDepth = Math.max(1, maxDepth);
    this.queue = this.createQueue(this._maxDepth);
  }

  private createQueue(maxDepth: number): MaxPriorityQueue<Snapshot> {
    return new MaxPriorityQueue<Snapshot>(this.compareSnapshots, maxDepth);
  }

  requestSnapshotId(baseSnapshotId?: SnapshotId): SnapshotId {
    const id = this.nextId;
    this.nextId += 1;
    const snapshot: Snapshot = {
      id,
      createdAt: Date.now(),
      status: "pending",
      content: "",
      renderedMarkdown: "",
      diffs: [],
      baseSnapshotId,
    };
    this.snapshots.set(id, snapshot);
    return id;
  }

  updateSnapshot(id: SnapshotId, update: SnapshotUpdate): Snapshot | null {
    const snapshot = this.snapshots.get(id);
    if (!snapshot) return null;
    Object.assign(snapshot, update);
    return snapshot;
  }

  appendDiff(id: SnapshotId, diff: SnapshotDiff): void {
    const snapshot = this.snapshots.get(id);
    if (!snapshot) return;
    snapshot.diffs.push(diff);
  }

  upsertRenderDiff(id: SnapshotId, diff: SnapshotDiff): void {
    const snapshot = this.snapshots.get(id);
    if (!snapshot) return;
    snapshot.diffs = snapshot.diffs.filter((entry) => entry.kind !== "render");
    snapshot.diffs.push(diff);
  }

  registerSnapshot(id: SnapshotId): Snapshot | null {
    const snapshot = this.snapshots.get(id);
    if (!snapshot) return null;
    if (this.registered.has(id)) {
      return snapshot;
    }
    this.registered.add(id);
    const removed = this.queue.push(snapshot);
    if (removed.length) {
      // Eviction trims both the queue and the lookup map so draft-pack generation only sees live history.
      removed.forEach((evicted) => {
        if (evicted.id !== id) {
          this.snapshots.delete(evicted.id);
          this.registered.delete(evicted.id);
        }
      });
    }
    return snapshot;
  }

  get(id: SnapshotId): Snapshot | null {
    return this.snapshots.get(id) ?? null;
  }

  list(): Snapshot[] {
    return this.queue.toArray();
  }
  setMaxDepth(maxDepth: number): void {
    this._maxDepth = Math.max(1, maxDepth);
    const snapshots = this.queue.toArray();
    this.queue = this.createQueue(this._maxDepth);
    this.registered.clear();
    snapshots.forEach((snapshot) => {
      this.registered.add(snapshot.id);
      this.queue.push(snapshot);
    });
  }

  getMaxDepth(): number {
    return this._maxDepth;
  }

  reset(): void {
    this.snapshots.clear();
    this.registered.clear();
    this.queue = this.createQueue(this._maxDepth);
    this.nextId = 1;
  }
}

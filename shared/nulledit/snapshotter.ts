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

/**
 * Maintains the browser's bounded window of recent editor snapshots.
 *
 * Snapshot ids are assigned before rendering so async preview work can be tied
 * back to the source text that triggered it. Only registered snapshots enter
 * the bounded queue used for draft-pack history; pending snapshots remain
 * addressable until they are rendered or reset.
 */
export default class Snapshotter {
  private readonly snapshots = new Map<SnapshotId, Snapshot>();

  private queue: MaxPriorityQueue<Snapshot>;
  private nextId = 1;
  private _maxDepth = 3;
  private readonly registered = new Set<SnapshotId>();

  private readonly compareSnapshots = (a: Snapshot, b: Snapshot) => a.id - b.id;

  /** Creates a snapshotter that retains at most `maxDepth` registered snapshots. */
  constructor(maxDepth = 3) {
    this._maxDepth = Math.max(1, maxDepth);
    this.queue = this.createQueue(this._maxDepth);
  }

  private createQueue(maxDepth: number): MaxPriorityQueue<Snapshot> {
    return new MaxPriorityQueue<Snapshot>(this.compareSnapshots, maxDepth);
  }

  /**
   * Reserves the next snapshot id and creates a pending snapshot record.
   *
   * The returned id is stable even if rendering is later cancelled, which lets
   * callers discard stale async work by comparing snapshot ids.
   */
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

  /** Updates mutable snapshot fields while preserving its id and diff history. */
  updateSnapshot(id: SnapshotId, update: SnapshotUpdate): Snapshot | null {
    const snapshot = this.snapshots.get(id);
    if (!snapshot) return null;
    Object.assign(snapshot, update);
    return snapshot;
  }

  /** Appends an edit or render diff to an existing snapshot. */
  appendDiff(id: SnapshotId, diff: SnapshotDiff): void {
    const snapshot = this.snapshots.get(id);
    if (!snapshot) return;
    snapshot.diffs.push(diff);
  }

  /** Replaces any previous render diff for the snapshot, preserving edit diffs. */
  upsertRenderDiff(id: SnapshotId, diff: SnapshotDiff): void {
    const snapshot = this.snapshots.get(id);
    if (!snapshot) return;
    snapshot.diffs = snapshot.diffs.filter((entry) => entry.kind !== "render");
    snapshot.diffs.push(diff);
  }

  /**
   * Marks a snapshot as retained history and evicts older registered snapshots.
   *
   * Registration is idempotent. Evicted snapshots are removed from both the
   * priority queue and lookup map so draft-pack generation only sees live
   * bounded history.
   */
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

  /** Returns a snapshot by id, including pending snapshots not yet registered. */
  get(id: SnapshotId): Snapshot | null {
    return this.snapshots.get(id) ?? null;
  }

  /** Lists registered snapshots retained in the bounded history window. */
  list(): Snapshot[] {
    return this.queue.toArray();
  }

  /** Resizes the retained-history window and trims existing registered snapshots. */
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

  /** Returns the current registered snapshot retention depth. */
  getMaxDepth(): number {
    return this._maxDepth;
  }

  /** Clears all snapshots and restarts id allocation from `1`. */
  reset(): void {
    this.snapshots.clear();
    this.registered.clear();
    this.queue = this.createQueue(this._maxDepth);
    this.nextId = 1;
  }
}

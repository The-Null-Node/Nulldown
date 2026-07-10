/*
These are the editor runtime primitives shared by the browser store, snapshotter, and
branch transport. `render` diffs and `edit` diffs are kept separately so the app can
preserve what the user typed alongside what the preview pipeline last rendered.
*/

/** Operation codes used by Nulledit's portable text-diff format. */
export enum DiffOp {
  /** Insert `data` at `range.start`. */
  INSERT = 0,
  /** Delete text in `[range.start, range.end)`. */
  DELETE = 1,
  /** Reserved for future wire-compatible retained spans. */
  RETAIN = 2,
}

/** Half-open source range measured in JavaScript string offsets. */
export interface DiffRange {
  /** Inclusive start offset. */
  start: number;
  /** Exclusive end offset. */
  end: number;
}

/** One portable edit operation used by browser snapshots and branch transport. */
export interface Diff {
  /** Operation to apply. */
  op: DiffOp;
  /** UTF-8 encoded operation payload. Empty for range-only deletes. */
  data: ArrayBuffer;
  /** Optional caller metadata preserved with the operation. */
  attributes?: Record<string, unknown>;
  /** Text range the operation applies to. */
  range?: DiffRange;
}

/** Monotonic in-memory editor snapshot identifier. */
export type SnapshotId = number;

/** Distinguishes user-source edits from preview-render output updates. */
export type SnapshotDiffKind = "edit" | "render";

/** Diff bundle attached to one snapshot transition. */
export interface SnapshotDiff {
  /** Whether this diff records source edits or rendered markdown changes. */
  kind: SnapshotDiffKind;
  /** Creation time in epoch milliseconds. */
  createdAt: number;
  /** Source text length before the diff. */
  fromLength: number;
  /** Source text length after the diff. */
  toLength: number;
  /** Ordered operations that transform the previous text into the next text. */
  ops: Diff[];
}

/** Lifecycle state for a browser editor snapshot. */
export type SnapshotStatus = "pending" | "rendered";

/** Available diff algorithms exposed by `getDiffer` and `computeDiffOps`. */
export type DiffAlgorithm = "prefix-suffix" | "lcs-dp";

/** Options for diff generation. */
export interface DiffOptions {
  /** Diff algorithm to use. Defaults to `prefix-suffix`. */
  algorithm?: DiffAlgorithm;

  /**
   * Max changed-middle length squared before LCS-DP falls back to prefix/suffix.
   * Defaults to 40,000 cells. Prevents O(n*m) blowups on large documents.
   */
  maxDpCells?: number;
}

/** Pluggable text differ used by Nulledit edit and render snapshotting. */
export interface Differ {
  /** Stable algorithm identifier. */
  readonly algorithm: DiffAlgorithm;
  /** Computes operations that transform `previous` into `next`. */
  compute(previous: string, next: string, options?: DiffOptions): Diff[];
}

/** Bounded editor state captured for draft packs, rendering, and branch diffs. */
export interface Snapshot {
  /** Snapshot id assigned by the in-memory `Snapshotter`. */
  id: SnapshotId;
  /** Creation time in epoch milliseconds. */
  createdAt: number;
  /** Whether the preview pipeline has rendered this snapshot. */
  status: SnapshotStatus;
  /** Source markdown captured at this snapshot. */
  content: string;
  /** Rendered markdown produced from `content`. */
  renderedMarkdown: string;
  /** Edit/render diffs associated with this snapshot. */
  diffs: SnapshotDiff[];
  /** Snapshot this one was requested from, when known. */
  baseSnapshotId?: SnapshotId;
}

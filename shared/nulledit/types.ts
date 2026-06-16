/*
These are the editor runtime primitives shared by the browser store, snapshotter, and
branch transport. `render` diffs and `edit` diffs are kept separately so the app can
preserve what the user typed alongside what the preview pipeline last rendered.
*/

export enum DiffOp {
  INSERT = 0,
  DELETE = 1,
  RETAIN = 2,
}

export interface DiffRange {
  start: number;
  end: number;
}

export interface Diff {
  op: DiffOp;
  data: ArrayBuffer;
  attributes?: Record<string, unknown>;
  range?: DiffRange;
}

export type SnapshotId = number;

export type SnapshotDiffKind = "edit" | "render";

export interface SnapshotDiff {
  kind: SnapshotDiffKind;
  createdAt: number;
  fromLength: number;
  toLength: number;
  ops: Diff[];
}

export type SnapshotStatus = "pending" | "rendered";

export type DiffAlgorithm = "prefix-suffix" | "lcs-dp";

export interface DiffOptions {
  algorithm?: DiffAlgorithm;

  /**
   * Max changed-middle length squared before LCS-DP falls back to prefix/suffix.
   * Defaults to 40,000 cells. Prevents O(n*m) blowups on large documents.
   */
  maxDpCells?: number;
}

export interface Differ {
  readonly algorithm: DiffAlgorithm;
  compute(previous: string, next: string, options?: DiffOptions): Diff[];
}

export interface Snapshot {
  id: SnapshotId;
  createdAt: number;
  status: SnapshotStatus;
  content: string;
  renderedMarkdown: string;
  diffs: SnapshotDiff[];
  baseSnapshotId?: SnapshotId;
}

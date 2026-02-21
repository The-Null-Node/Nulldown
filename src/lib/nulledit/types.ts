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

export interface Snapshot {
  id: SnapshotId;
  createdAt: number;
  status: SnapshotStatus;
  content: string;
  renderedMarkdown: string;
  diffs: SnapshotDiff[];
  baseSnapshotId?: SnapshotId;
}

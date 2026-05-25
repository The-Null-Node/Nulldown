import type {
  DropDraftDiffPolicy,
  DropDraftDiffOp,
  DropDraftPackV1,
  DropDraftSnapshot,
} from "../../../shared/drop/types";
import type Snapshotter from "../../../shared/nulledit/snapshotter";
import { decodeText } from "../../../shared/nulledit/textDiff";
import { DiffOp, type SnapshotDiff } from "../../../shared/nulledit/types";

const DEFAULT_MAX_OPS = 160;
const DEFAULT_MAX_BYTES = 24 * 1024;

export interface BuildDraftPackOptions {
  snapshotter: Snapshotter;
  snapshotId: number | null;
  policy: DropDraftDiffPolicy;
  source: "new-drop" | "edited-drop";
  maxOps?: number;
  maxBytes?: number;
}

const toDraftOps = (
  snapshotDiff: SnapshotDiff,
  maxOps: number,
  maxBytes: number,
  budget: { opCount: number; byteCount: number; truncated: boolean },
): DropDraftDiffOp[] => {
  const collected: DropDraftDiffOp[] = [];

  for (const operation of snapshotDiff.ops) {
    if (operation.op !== DiffOp.INSERT && operation.op !== DiffOp.DELETE) {
      continue;
    }

    if (budget.opCount >= maxOps) {
      budget.truncated = true;
      break;
    }

    const range = operation.range ?? { start: 0, end: 0 };
    const text = decodeText(operation.data);
    const nextOperation: DropDraftDiffOp = {
      type: operation.op === DiffOp.INSERT ? "insert" : "delete",
      start: Math.max(0, range.start),
      end: Math.max(0, range.end),
      text,
    };

    const operationBytes = JSON.stringify(nextOperation).length;
    if (budget.byteCount + operationBytes > maxBytes) {
      budget.truncated = true;
      break;
    }

    budget.byteCount += operationBytes;
    budget.opCount += 1;
    collected.push(nextOperation);
  }

  return collected;
};

export const buildDraftPackFromSnapshot = (
  options: BuildDraftPackOptions,
): DropDraftPackV1 | undefined => {
  if (!options.snapshotId) {
    return undefined;
  }

  const snapshot = options.snapshotter.get(options.snapshotId);
  if (!snapshot) {
    return undefined;
  }

  const maxOps = Math.max(1, options.maxOps ?? DEFAULT_MAX_OPS);
  const maxBytes = Math.max(1024, options.maxBytes ?? DEFAULT_MAX_BYTES);

  const budget = {
    opCount: 0,
    byteCount: 0,
    truncated: false,
  };

  const snapshots: DropDraftSnapshot[] = [];
  const editDiffs = snapshot.diffs.filter((entry) => entry.kind === "edit");

  editDiffs.forEach((snapshotDiff) => {
    if (budget.truncated) {
      return;
    }

    const ops = toDraftOps(snapshotDiff, maxOps, maxBytes, budget);
    if (!ops.length) {
      return;
    }

    snapshots.push({
      snapshotId: snapshot.id,
      createdAt: snapshotDiff.createdAt,
      fromLength: snapshotDiff.fromLength,
      toLength: snapshotDiff.toLength,
      ops,
    });
  });

  if (!snapshots.length) {
    return undefined;
  }

  return {
    version: 1,
    policy: options.policy,
    source: options.source,
    createdAt: Date.now(),
    currentSnapshotId: snapshot.id,
    truncated: budget.truncated || undefined,
    snapshots,
  };
};

import type { DropBranchRecord } from "../../shared/drop/branch";
import { computeDiffOps, decodeText } from "../../shared/nulledit/textDiff";
import { DiffOp } from "../../shared/nulledit/types";

/** Branch records grouped for the activity dialog. */
export interface BranchActivityGroups {
  mine: DropBranchRecord[];
  main: DropBranchRecord[];
  other: DropBranchRecord[];
}

/** Local text changes needed to transform the editor buffer into a branch head. */
export interface BranchTextComparisonSummary {
  additions: number;
  removals: number;
  operations: number;
}

/** Groups branch metadata without changing the source ordering from storage. */
export const groupBranchActivity = (
  branches: readonly DropBranchRecord[],
  activeBranchId: string,
): BranchActivityGroups => {
  const groups: BranchActivityGroups = { mine: [], main: [], other: [] };

  for (const branch of branches) {
    if (branch.branchId === activeBranchId) {
      groups.mine.push(branch);
    }
    if (branch.mode === "owner") {
      groups.main.push(branch);
    } else if (branch.branchId !== activeBranchId) {
      groups.other.push(branch);
    }
  }

  return groups;
};

/** Returns the branch-specific writer identity without conflating it with root ownership. */
export const getBranchWriterLabel = (branch: DropBranchRecord): string =>
  branch.writerAccountId ?? branch.writerClientId ?? "Unknown writer";

/** Summarizes a read-only editor-buffer to branch-head text comparison. */
export const summarizeBranchTextComparison = (
  current: string,
  selected: string,
): BranchTextComparisonSummary => {
  const diffs = computeDiffOps(current, selected, { algorithm: "lcs-dp" });
  let additions = 0;
  let removals = 0;

  for (const diff of diffs) {
    const length = decodeText(diff.data).length;
    if (diff.op === DiffOp.INSERT) {
      additions += length;
    } else if (diff.op === DiffOp.DELETE) {
      removals += length;
    }
  }

  return { additions, removals, operations: diffs.length };
};

import type { DropBranchRecord } from "../../shared/drop/branch";
import {
  getBranchWriterLabel,
  groupBranchActivity,
  summarizeBranchTextComparison,
} from "./branchActivity";

const branch = (
  branchId: string,
  mode: DropBranchRecord["mode"],
  overrides: Partial<DropBranchRecord> = {},
): DropBranchRecord => ({
  version: 1,
  branchId,
  rootDropId: "root-1",
  baseDropId: "root-1",
  mode,
  status: "active",
  ownerAccountId: "root-owner",
  writerAccountId: "writer-1",
  writerClientId: null,
  headSnapshotId: 2,
  headEventSeq: 4,
  createdAt: 1,
  updatedAt: 2,
  ...overrides,
});

describe("branch activity", () => {
  it("groups the active writer, owner branch, and other actor branches", () => {
    const mine = branch("clone_account:mine", "clone");
    const main = branch("owner", "owner", { writerAccountId: "root-owner" });
    const other = branch("clone_account:other", "clone");

    expect(groupBranchActivity([mine, main, other], mine.branchId)).toEqual({
      mine: [mine],
      main: [main],
      other: [other],
    });
  });

  it("keeps root ownership and branch writer identity distinct", () => {
    const clientBranch = branch("clone_client:browser", "clone", {
      writerAccountId: null,
      writerClientId: "browser-1",
    });

    expect(clientBranch.ownerAccountId).toBe("root-owner");
    expect(getBranchWriterLabel(clientBranch)).toBe("browser-1");
  });

  it("keeps an active owner branch visible as Main", () => {
    const owner = branch("owner", "owner", { writerAccountId: "root-owner" });

    expect(groupBranchActivity([owner], owner.branchId)).toEqual({
      mine: [owner],
      main: [owner],
      other: [],
    });
  });

  it("summarizes current-buffer changes without mutating either input", () => {
    const current = "cat";
    const selected = "cut";

    expect(summarizeBranchTextComparison(current, selected)).toEqual({
      additions: 1,
      removals: 1,
      operations: 2,
    });
    expect(current).toBe("cat");
    expect(selected).toBe("cut");
  });

  it("reports equal, addition-only, and removal-only comparisons", () => {
    expect(summarizeBranchTextComparison("same", "same")).toEqual({
      additions: 0,
      removals: 0,
      operations: 0,
    });
    expect(summarizeBranchTextComparison("a", "ab")).toEqual({
      additions: 1,
      removals: 0,
      operations: 1,
    });
    expect(summarizeBranchTextComparison("ab", "a")).toEqual({
      additions: 0,
      removals: 1,
      operations: 1,
    });
  });
});

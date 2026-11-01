import { describe, expect, it } from "@jest/globals";
import { sanitizeBranchId } from "./branch-identity";
import { BranchStateQuery } from "./branch-state";

describe("branch identity bounds", () => {
  it("preserves stable clone identities at the account limit without widening root IDs", () => {
    const branchId = `clone_account:${"a".repeat(120)}`;
    expect(sanitizeBranchId(branchId)).toBe(branchId);
    const query = {
      target: { rootDropId: "root", branchId },
      placement: { routingVersion: 1, generation: 0 },
    };
    expect(BranchStateQuery.head(query)).toEqual(query);
    expect(() =>
      BranchStateQuery.head({
        ...query,
        target: { rootDropId: "r".repeat(121), branchId },
      }),
    ).toThrow("invalid_command");
    expect(sanitizeBranchId(`${branchId}a`)).toBeNull();
    expect(() =>
      BranchStateQuery.head({
        ...query,
        target: { rootDropId: "root", branchId: `${branchId}a` },
      }),
    ).toThrow("invalid_command");
  });

  it("keeps HTTP paths restricted while portable state identities retain exact UTF-16", () => {
    expect(sanitizeBranchId("owner/path")).toBeNull();
    expect(sanitizeBranchId(" owner ")).toBe("owner");
    const target = { rootDropId: "root", branchId: "exact/\ud800" };
    expect(
      BranchStateQuery.head({
        target,
        placement: { routingVersion: 1, generation: 0 },
      }).target,
    ).toEqual(target);
  });
});

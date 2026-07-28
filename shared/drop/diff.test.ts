import {
  createDropDiffRef,
  createDropDiffRenderableRef,
  isDropBranchRuntimeFact,
  isDropDiffRef,
  isDropDiffRenderableRef,
} from "./diff";

describe("DropDiffRef", () => {
  it("formats and validates renderable diff refs", () => {
    const ref = createDropDiffRenderableRef("evt-1");

    expect(ref).toBe("<diff:evt-1>");
    expect(isDropDiffRenderableRef(ref)).toBe(true);
    expect(isDropDiffRenderableRef("diff:evt-1")).toBe(false);
  });

  it("creates stable branch diff refs", () => {
    const ref = createDropDiffRef({
      rootDropId: "root-1",
      branchId: "owner",
      seq: 7,
      eventId: "evt-7",
      snapshotId: 3,
    });

    expect(ref).toEqual({
      rootDropId: "root-1",
      branchId: "owner",
      seq: 7,
      eventId: "evt-7",
      ref: "<diff:evt-7>",
      snapshotId: 3,
    });
    expect(isDropDiffRef(ref)).toBe(true);
    expect(isDropDiffRef({ ...ref, ref: "<diff:other>" })).toBe(false);
  });
});

describe("DropBranchRuntimeFact", () => {
  it("requires the payload source to match its branch timeline", () => {
    const fact = {
      version: 1,
      rootDropId: "root-1",
      branchId: "branch-1",
      seq: 0,
      factId: "ui.state.patch:patch-1",
      createdAt: 1,
      fact: {
        version: 1,
        kind: "ui.state.patch",
        id: "patch-1",
        callId: "call-1",
        createdAt: 1,
        source: {
          rootDropId: "root-1",
          branchId: "branch-1",
          callId: "call-1",
        },
        patch: [{ op: "set", path: ["approved"], value: true }],
      },
    };

    expect(isDropBranchRuntimeFact(fact)).toBe(true);
    expect(
      isDropBranchRuntimeFact({
        ...fact,
        branchId: "other-branch",
      }),
    ).toBe(false);
  });
});

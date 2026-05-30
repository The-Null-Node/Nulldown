import {
  createDropDiffRef,
  createDropDiffRenderableRef,
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

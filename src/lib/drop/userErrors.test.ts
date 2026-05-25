import { toUserFacingDropError } from "./userErrors";

describe("toUserFacingDropError", () => {
  it("normalizes sync conflict messages", () => {
    const message =
      'Sync conflict for drop "abc123". Resolve it before publishing again.';

    expect(toUserFacingDropError(new Error(message))).toBe(
      "This drop changed elsewhere. Refresh and try sharing again.",
    );
  });

  it("normalizes revision precondition conflict code", () => {
    expect(toUserFacingDropError(new Error("revision_precondition_failed"))).toBe(
      "This drop changed elsewhere. Refresh and try sharing again.",
    );
  });
});

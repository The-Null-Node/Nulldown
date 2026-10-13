import { toUserFacingDropError } from "./user-errors";

describe("toUserFacingDropError", () => {
  it("explains the private-envelope branch limitation without calling it a missing drop", () => {
    const error = new Error(
      "Failed to resolve branch: Remote branch editing is not available for encrypted drop envelopes yet.",
    );
    expect(toUserFacingDropError(error)).toBe(
      "This encrypted drop cannot be edited through a remote branch yet. You can view its content; editing and publishing are unavailable.",
    );
  });
  it("normalizes sync conflict messages", () => {
    const message =
      'Sync conflict for drop "abc123". Resolve it before publishing again.';

    expect(toUserFacingDropError(new Error(message))).toBe(
      "This drop changed elsewhere. Refresh and try sharing again.",
    );
  });

  it("normalizes revision precondition conflict code", () => {
    expect(
      toUserFacingDropError(new Error("revision_precondition_failed")),
    ).toBe("This drop changed elsewhere. Refresh and try sharing again.");
  });
});

/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import { jest } from "@jest/globals";
import type { DiffSyncState } from "../hooks/useDiffChannel";
import BranchSyncBanner from "./BranchSyncBanner";

const blockedState: DiffSyncState = {
  mode: "blocked",
  pendingCount: 1,
  message: "Remote changes require conflict recovery before local edits can sync.",
  canEdit: true,
};

describe("BranchSyncBanner", () => {
  it("keeps the conflict visible and lets the user choose the remote branch", () => {
    const onUseRemoteBranch = jest.fn();
    render(
      <BranchSyncBanner
        state={blockedState}
        onUseRemoteBranch={onUseRemoteBranch}
      />,
    );

    expect(screen.getByText("Sync conflict")).not.toBeNull();
    expect(screen.getByText(/still on this device/)).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Use remote branch" }));
    expect(onUseRemoteBranch).toHaveBeenCalledTimes(1);
  });
});

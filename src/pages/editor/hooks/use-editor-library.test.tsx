/** @jest-environment jsdom */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { jest } from "@jest/globals";
import { StrictMode } from "react";
import type { OwnedDropRecord } from "../../../stores/drop-store";
import type { AccountLibraryPage } from "../../../../shared/auth/account-library";

const owned = jest.fn<() => Promise<OwnedDropRecord[]>>();
const remote = jest.fn<() => Promise<AccountLibraryPage>>();
jest.unstable_mockModule("../../../stores/drop-store", () => ({
  default: (selector: (state: { listOwnedDrops: typeof owned }) => unknown) =>
    selector({ listOwnedDrops: owned }),
}));
jest.unstable_mockModule("../../../lib/auth/account-library-client", () => ({
  fetchAccountLibrary: remote,
}));
jest.unstable_mockModule("../../../lib/draft/library", () => ({
  listDraftLibraryEntries: () => [],
}));
jest.unstable_mockModule("../../../lib/drop/recent-external-drops", () => ({
  listRecentExternalDrops: () => [],
}));
const { useEditorLibrary } = await import("./use-editor-library");
const record = (id: string): OwnedDropRecord => ({
  id,
  visibility: "private",
  createdAt: 1,
  updatedAt: 1,
});
beforeEach(() => {
  owned.mockReset().mockResolvedValue([]);
  remote.mockReset().mockResolvedValue({ items: [], cursor: null });
});
afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

it("ignores an old refresh when a newer refresh finishes first", async () => {
  let finish!: (records: OwnedDropRecord[]) => void;
  owned.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const view = renderHook(() => useEditorLibrary(true));
  owned.mockResolvedValue([record("newer")]);
  await act(async () => {
    await view.result.current.refresh();
  });
  await act(async () => {
    finish([record("obsolete")]);
  });
  expect(view.result.current.library.drops.map((drop) => drop.id)).toEqual([
    "newer",
  ]);
  expect(remote).toHaveBeenCalledTimes(1);
  expect(view.result.current.loading).toBe(false);
});

it("retains results and reports local failure even when remote refresh succeeds", async () => {
  jest.spyOn(console, "error").mockImplementation(() => {});
  owned.mockResolvedValue([record("retained")]);
  const view = renderHook(() => useEditorLibrary(true));
  await waitFor(() => expect(view.result.current.loading).toBe(false));
  owned.mockRejectedValue(new Error("local failed"));
  await act(async () => {
    await view.result.current.refresh();
  });
  expect(view.result.current.library.drops).toEqual([record("retained")]);
  expect(view.result.current.error).toContain("local library");
});

it("fences StrictMode replay and stops a pending refresh on unmount", async () => {
  let finish!: (records: OwnedDropRecord[]) => void;
  const pending = new Promise<OwnedDropRecord[]>((resolve) => {
    finish = resolve;
  });
  owned.mockReturnValue(pending);
  const view = renderHook(() => useEditorLibrary(true), {
    wrapper: ({ children }) => <StrictMode>{children}</StrictMode>,
  });
  view.unmount();
  await act(async () => {
    finish([]);
    await pending;
  });
  expect(remote).not.toHaveBeenCalled();
});

it("applies remote deletion markers before deriving the current library", async () => {
  remote.mockResolvedValue({
    items: [
      {
        state: "active",
        id: "removed",
        visibility: "private",
        createdAt: 1,
        updatedAt: 1,
      },
      { state: "deleted", id: "removed", deletedAt: 2 },
    ],
    cursor: null,
  });
  const view = renderHook(() => useEditorLibrary(true));
  await waitFor(() => expect(view.result.current.loading).toBe(false));
  expect(remote).toHaveBeenCalledTimes(1);
  expect(view.result.current.library.remoteEntries).toEqual([]);
});

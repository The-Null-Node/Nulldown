/** @jest-environment jsdom */
import { act, cleanup, renderHook } from "@testing-library/react";
import { jest } from "@jest/globals";
import { TextEncoder, TextDecoder } from "node:util";

Object.assign(globalThis, { TextEncoder, TextDecoder });
jest.unstable_mockModule("../../../theme/theme-context", () => ({
  useTheme: () => ({ themeId: "system" }),
}));
const { useShareDrop } = await import("./use-share-drop");
const { default: useDropStore } = await import("../../../stores/drop-store");
const initial = useDropStore.getState();
afterEach(() => {
  cleanup();
  useDropStore.setState(initial, true);
});

it("keeps late branch publication from clearing a replacement route", async () => {
  let active = true;
  let finish!: (value: { url: string }) => void;
  const pending = new Promise<{ url: string }>((resolve) => {
    finish = resolve;
  });
  const publishBranch = jest.fn(() => pending);
  const clearDraft = jest.fn<() => void>();
  useDropStore.setState({
    hydrateOfflineMode: async () => {},
    hydrateSharePreferences: async () => {},
  });
  const hook = renderHook(() =>
    useShareDrop("origin", clearDraft, {
      publishBranch,
      isActive: () => active,
      canShare: true,
    }),
  );
  let sharing!: Promise<void>;
  await act(async () => {
    sharing = hook.result.current.shareDrop();
    await Promise.resolve();
  });
  expect(publishBranch).toHaveBeenCalledTimes(1);
  active = false;
  hook.unmount();
  await act(async () => {
    finish({ url: "old-result" });
    await sharing;
  });
  expect(clearDraft).not.toHaveBeenCalled();
});

it("refuses publication while bootstrap is incomplete", async () => {
  const publishBranch = jest.fn(async () => ({ url: "unexpected" }));
  const hook = renderHook(() =>
    useShareDrop("old visible content", () => {}, {
      publishBranch,
      canShare: false,
    }),
  );
  await act(async () => {
    await hook.result.current.shareDrop();
  });
  expect(publishBranch).not.toHaveBeenCalled();
  expect(hook.result.current.error).toContain("finish loading");
});

it("uses settings loaded during sharing rather than the render-time defaults", async () => {
  const createDrop = jest.fn(async () => ({
    id: "saved",
    url: "saved",
    scope: "local" as const,
  }));
  const buildDraftPack = jest.fn(() => undefined);
  useDropStore.setState({
    draftDiffPolicy: "edited-only",
    allowedUrls: [],
    createDrop,
    hydrateOfflineMode: async () => {},
    hydrateSharePreferences: async () => {
      useDropStore.setState({
        draftDiffPolicy: "always",
        allowedUrls: ["https://example.com"],
      });
    },
  });
  const hook = renderHook(() =>
    useShareDrop("content", () => {}, { buildDraftPack }),
  );
  await act(async () => {
    await hook.result.current.shareDrop();
  });
  expect(buildDraftPack).toHaveBeenCalledWith("always");
  expect(createDrop).toHaveBeenCalledWith(
    expect.objectContaining({
      metadata: expect.objectContaining({
        allowedUrls: ["https://example.com"],
      }),
    }),
    undefined,
  );
});

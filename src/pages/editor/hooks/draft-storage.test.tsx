/** @jest-environment jsdom */
import React, { StrictMode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { jest } from "@jest/globals";
import {
  useDraftStorage,
  useLocalStorageLoad,
} from "../../../hooks/use-local-storage";
import useStorageStore from "../../../stores/storage-store";

const initial = useStorageStore.getState();
afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
  useStorageStore.setState(initial, true);
});

it("distinguishes a failed draft read from a missing or empty draft", () => {
  useStorageStore.setState({ isClient: true });
  jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("storage unavailable");
  });
  expect(() =>
    useStorageStore.getState().getItem("draft:A", { throwOnError: true }),
  ).toThrow("storage unavailable");
});

it("does not save an unready draft or automatically load a manually bootstrapped route", async () => {
  const getItem = jest.fn(() => "saved");
  const setItem = jest.fn(() => ({ success: true }));
  useStorageStore.setState({ isClient: true, getItem, setItem });
  const loaded = jest.fn();
  const hook = renderHook(
    ({ ready }) =>
      useDraftStorage("draft:A", "", loaded, {
        autoSave: ready,
        autoLoad: false,
      }),
    { initialProps: { ready: false } },
  );
  await act(async () => {
    await new Promise((r) => setTimeout(r, 280));
  });
  expect(setItem).not.toHaveBeenCalled();
  expect(getItem).not.toHaveBeenCalled();
  hook.rerender({ ready: true });
  await waitFor(() => expect(setItem).toHaveBeenCalledWith("draft:A", ""));
});

it("ignores an old key completion and restores empty drafts under StrictMode", async () => {
  let resolveOld!: (value: string) => void;
  const old = new Promise<string>((resolve) => {
    resolveOld = resolve;
  });
  useStorageStore.setState({
    isClient: true,
    // Delayed adapter exposes the hook's stale-completion race deterministically.
    getItem: ((key: string) =>
      key === "A" ? old : "") as unknown as typeof initial.getItem,
  });
  const loaded = jest.fn();
  const hook = renderHook(({ name }) => useLocalStorageLoad(name, loaded), {
    initialProps: { name: "A" },
    wrapper: ({ children }) => <StrictMode>{children}</StrictMode>,
  });
  hook.rerender({ name: "B" });
  await waitFor(() => expect(loaded).toHaveBeenCalledWith(""));
  await act(async () => {
    resolveOld("obsolete");
    await old;
  });
  expect(loaded).toHaveBeenCalledTimes(1);
});

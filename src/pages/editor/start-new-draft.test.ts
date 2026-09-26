/** @jest-environment jsdom */
import { jest } from "@jest/globals";
import { startNewDraft } from "./start-new-draft";
import useStorageStore from "../../stores/storage-store";
import {
  createDraftStorageKey,
  listDraftLibraryEntries,
} from "../../lib/draft/library";

const initial = useStorageStore.getState();
afterEach(() => {
  useStorageStore.setState(initial, true);
  localStorage.clear();
  jest.restoreAllMocks();
});

it("preserves selected draft B and its latest unsaved text when creating successive new documents", () => {
  useStorageStore.setState({ isClient: true });
  const b = createDraftStorageKey("B");
  localStorage.setItem(b, "older B");
  const navigate = jest.fn<(url: string) => void>();
  startNewDraft({ draftKey: b, content: "latest B", dropId: null, navigate });
  const firstId = new URL(
    navigate.mock.calls[0][0],
    "http://localhost",
  ).searchParams.get("draft")!;
  const firstKey = createDraftStorageKey(firstId);
  expect(firstKey).not.toBe(b);
  expect(localStorage.getItem(firstKey)).toBeNull();
  localStorage.setItem(firstKey, "new document text");
  expect(localStorage.getItem(b)).toBe("latest B");
  expect(
    listDraftLibraryEntries().find((entry) => entry.draftKey === b)?.preview,
  ).toBe("latest B");
  startNewDraft({
    draftKey: firstKey,
    content: "new document text",
    dropId: null,
    navigate,
  });
  expect(navigate.mock.calls[1][0]).not.toBe(navigate.mock.calls[0][0]);
  expect(localStorage.getItem(b)).toBe("latest B");
  expect(localStorage.getItem(firstKey)).toBe("new document text");
});

it("stays on the current route if saving fails", () => {
  useStorageStore.setState({
    setItem: () => ({ success: false, error: "storage full" }),
  });
  const navigate = jest.fn();
  expect(() =>
    startNewDraft({ draftKey: "B", content: "keep", dropId: null, navigate }),
  ).toThrow("storage full");
  expect(navigate).not.toHaveBeenCalled();
});

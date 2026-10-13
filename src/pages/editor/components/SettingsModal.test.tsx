/** @jest-environment jsdom */
import { cleanup, render, waitFor } from "@testing-library/react";
import { jest } from "@jest/globals";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import { TextEncoder, TextDecoder } from "node:util";
import { serialize, deserialize } from "node:v8";

Object.assign(globalThis, {
  indexedDB,
  IDBKeyRange,
  TextEncoder,
  TextDecoder,
  structuredClone: (value: unknown) => deserialize(serialize(value)),
});
jest.unstable_mockModule("../../../theme/theme-context", () => ({
  useTheme: () => ({ themeId: "system", typefaceId: "system" }),
  useThemeCatalog: () => [],
  useTypefaceCatalog: () => [
    { id: "system", name: "System", description: "System typeface" },
  ],
  useThemeStore: { getState: () => ({}) },
}));
const { setKvItem, setKvValue, getKvValue } =
  await import("../../../lib/indexed-db/key-value");
const { default: store } = await import("../../../stores/drop-store");
const { default: SettingsModal } = await import("./SettingsModal");
afterEach(cleanup);

it("opening settings hydrates real IndexedDB preferences without draining queued publication", async () => {
  await setKvItem("nulldown_offline_mode", "online");
  await setKvItem("nulldown_share_visibility", "public");
  const queue = [
    {
      version: 1,
      dropId: "offline_settings_test",
      visibility: "private",
      source: "create_online",
      queuedAt: 1,
    },
  ];
  await setKvValue("nulldown_sync_queue_v1", queue);
  const startup = jest.spyOn(store.getState(), "startPublication");
  const view = render(<SettingsModal open={false} onClose={() => {}} />);
  view.rerender(<SettingsModal open onClose={() => {}} />);
  await waitFor(() => expect(store.getState().shareVisibility).toBe("public"));
  expect(startup).not.toHaveBeenCalled();
  expect(store.getState().syncQueueDepth).toBe(0);
  expect(await getKvValue("nulldown_sync_queue_v1")).toEqual(queue);
  startup.mockRestore();
});

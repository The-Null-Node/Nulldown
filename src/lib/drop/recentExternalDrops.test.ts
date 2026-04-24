import {
  listRecentExternalDrops,
  upsertRecentExternalDrop,
} from "./recentExternalDrops";

describe("recentExternalDrops", () => {
  beforeAll(() => {
    const storage = new Map<string, string>();

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: {
          clear: () => storage.clear(),
          getItem: (key: string) => storage.get(key) ?? null,
          removeItem: (key: string) => {
            storage.delete(key);
          },
          setItem: (key: string, value: string) => {
            storage.set(key, value);
          },
        },
      },
    });
  });

  beforeEach(() => {
    window.localStorage.clear();
  });

  it("stores and sorts recent external drops by updated time", () => {
    upsertRecentExternalDrop({
      id: "drop-1",
      title: "First",
      preview: "First preview",
      updatedAt: 10,
    });
    upsertRecentExternalDrop({
      id: "drop-2",
      title: "Second",
      preview: "Second preview",
      updatedAt: 20,
    });

    expect(listRecentExternalDrops().map((entry) => entry.id)).toEqual([
      "drop-2",
      "drop-1",
    ]);
  });

  it("deduplicates entries by id and keeps the latest metadata", () => {
    upsertRecentExternalDrop({
      id: "drop-1",
      title: "Older",
      preview: "Older preview",
      updatedAt: 10,
    });
    upsertRecentExternalDrop({
      id: "drop-1",
      title: "Newer",
      preview: "Updated preview",
      updatedAt: 20,
    });

    expect(listRecentExternalDrops()).toEqual([
      {
        id: "drop-1",
        title: "Newer",
        preview: "Updated preview",
        updatedAt: 20,
      },
    ]);
  });
});

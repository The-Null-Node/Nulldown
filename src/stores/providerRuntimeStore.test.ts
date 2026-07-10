import { create } from "zustand";
import {
  createProviderRuntimeStore,
  providerRuntimeVersionCacheKey,
  type ProviderRuntimeState,
} from "./providerRuntimeStore";
import type { DropRuntimeVersionRef } from "../../shared/drop/runtime";

const createStore = () => create<ProviderRuntimeState>(createProviderRuntimeStore);

const version = (
  overrides: Partial<DropRuntimeVersionRef> = {},
): DropRuntimeVersionRef => ({
  rootDropId: "root",
  branchId: "branch",
  snapshotId: 1,
  eventSeq: 1,
  contentHash: "content-a",
  ...overrides,
});

describe("provider runtime store", () => {
  it("builds stable provider version cache keys", () => {
    expect(
      providerRuntimeVersionCacheKey({
        provider: "local",
        rootDropId: "root",
        branchId: "branch",
      }),
    ).toBe("local:root:branch");
  });

  it("sets, gets, and clears provider-scoped versions", () => {
    const store = createStore();
    const key = { provider: "local" as const, rootDropId: "root", branchId: "branch" };

    store.getState().setVersion(key, version({ snapshotId: 2 }), 123);

    expect(store.getState().getVersion(key)).toEqual(
      expect.objectContaining({ snapshotId: 2 }),
    );
    expect(Object.values(store.getState().versions)[0]?.updatedAt).toBe(123);

    store.getState().clearVersion(key);

    expect(store.getState().getVersion(key)).toBeNull();
  });

  it("compares cached local and remote versions", () => {
    const store = createStore();
    const ref = { rootDropId: "root", branchId: "branch" };

    store.getState().setVersion({ provider: "local", ...ref }, version({ eventSeq: 3 }));
    store.getState().setVersion({ provider: "remote", ...ref }, version({ eventSeq: 1 }));

    expect(store.getState().compareCachedVersions(ref)).toEqual(
      expect.objectContaining({
        status: "local-ahead",
        reasons: ["local-version-newer"],
      }),
    );
  });

  it("clears all cached versions", () => {
    const store = createStore();
    store
      .getState()
      .setVersion({ provider: "remote", rootDropId: "root", branchId: "branch" }, version());

    store.getState().clearAll();

    expect(store.getState().versions).toEqual({});
  });
});

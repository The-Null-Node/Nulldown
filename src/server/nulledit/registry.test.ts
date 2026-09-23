import { createNulleditSnapshotterRegistry } from "./registry";
import type { NulleditSnapshotter } from "./types";

describe("Nulledit snapshotter registry contracts", () => {
  it("registers persistent snapshotters with defensive list copies", () => {
    const initial: NulleditSnapshotter = {
      id: "initial-snapshotter",
      snapshot() {},
    };
    const registered: NulleditSnapshotter = {
      id: "registered-snapshotter",
      snapshot() {},
    };
    const registry = createNulleditSnapshotterRegistry([initial]);

    const copy = registry.list();
    copy.length = 0;
    expect(registry.list()).toEqual([initial]);

    const unsubscribe = registry.register(registered);
    expect(registry.list()).toEqual([initial, registered]);

    unsubscribe();
    unsubscribe();
    expect(registry.list()).toEqual([initial]);
  });
});

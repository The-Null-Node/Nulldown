import type {
  NulleditNextRequest,
  NulleditNextResult,
  NulleditSnapshotter,
  NulleditSnapshotterRegistry,
} from "./types";

/** Creates an in-memory registry for persistent Nulledit snapshotters. */
export const createNulleditSnapshotterRegistry = (
  initialSnapshotters: readonly NulleditSnapshotter[] = [],
): NulleditSnapshotterRegistry => {
  const snapshotters = [...initialSnapshotters];

  return {
    register(snapshotter) {
      snapshotters.push(snapshotter);
      let registered = true;
      return () => {
        if (!registered) return;
        registered = false;
        const index = snapshotters.indexOf(snapshotter);
        if (index >= 0) snapshotters.splice(index, 1);
      };
    },
    list() {
      return [...snapshotters];
    },
    yieldNext(id: string, request?: NulleditNextRequest): NulleditNextResult | Promise<NulleditNextResult> | undefined {
      const s = snapshotters.find((x) => x.id === id);
      return s?.yieldNext?.(request);
    },
  };
};

import type { NulleditSnapshotter } from "../types";
import { createNulleditDiffRefSnapshotter } from "./diffRefs";
import { createNulleditFrameSnapshotter } from "./frame";
import { createNulleditPolicyObserverSnapshotter } from "./policyObserver";
import { createNulleditResolvedDocumentSnapshotter } from "./resolvedDocument";

/** Creates the built-in Nulledit snapshotters registered by provider adapters. */
export const createBuiltInNulleditSnapshotters = (): NulleditSnapshotter[] => [
  createNulleditFrameSnapshotter(),
  createNulleditDiffRefSnapshotter(),
  createNulleditPolicyObserverSnapshotter(),
  createNulleditResolvedDocumentSnapshotter(),
];

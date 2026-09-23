import type { NulleditSnapshotter } from "../types";
import { createNulleditDiffRefSnapshotter } from "./diff-refs";
import { createNulleditFrameSnapshotter } from "./frame";
import { createNulleditPolicyObserverSnapshotter } from "./policy-observer";
import { createNulleditResolvedDocumentSnapshotter } from "./resolved-document";

/** Creates the built-in Nulledit snapshotters registered by provider adapters. */
export const createBuiltInNulleditSnapshotters = (): NulleditSnapshotter[] => [
  createNulleditFrameSnapshotter(),
  createNulleditDiffRefSnapshotter(),
  createNulleditPolicyObserverSnapshotter(),
  createNulleditResolvedDocumentSnapshotter(),
];

import type { DropDiffEvent, DropDiffOp } from "../../../shared/drop/diff";
import type { MemoryBranchStateSeed } from "../../../src/server/state-plane/memory-commits";
import { decodeDropEnvelope } from "../../../shared/drop/codecs/envelope-v1";

/** Synthetic identities shared by the local driver and fixture; never hosted roots. */
export const applicationFixture = {
  root: "Wave2Accept01",
  publicRoot: "Wave2Public01",
  branch: "fixture-writer",
  owner: "wave2-owner",
  writer: "wave2-writer",
  stranger: "wave2-stranger",
  placement: { routingVersion: 1, generation: 0 },
  initial: "# Wave2\nred blue\n",
  green: "# Wave2\ngreen blue\n",
  second: "# Wave2\ngreen blue\nclient B\n",
  batch: "Note\n# Wave2\ngreen blue\nclient B\ndone\n",
  saved: "Note\n# Wave2\ngreen blue\nclient B\ndone\nsaved\n",
  final: "Note\n# Wave2\ngreen blue\nclient B\ndone\nsaved\nlater\n",
} as const;

/** Distinct roots created by the real store route, never by branch/projection fixture seeding. */
export const applicationLifecycleFixture = {
  root: "LifeCycleRoot01",
  privateRoot: "LifePrivateRoot01",
  concurrentRoot: "RaceLifeRoot01",
  lostRoot: "LostLifeRoot01",
  crashRoot: "CrashLifeRoot01",
  legacyRoot: "LegacyLifeRoot01",
  owner: "lifecycle-owner",
  writer: "lifecycle-writer",
  otherWriter: "lifecycle-other-writer",
  initial: "# Lifecycle\ncreated through the SDK\n",
  privateInitial: "# Private lifecycle\nowner only\n",
  first: "# Lifecycle\ncreated through the SDK\nfirst\n",
  second: "# Lifecycle\ncreated through the SDK\nfirst\nsecond\n",
  historyLastSnapshot: 201,
  historyLine: "history\n",
  historyFinal:
    "# Lifecycle\ncreated through the SDK\nfirst\nsecond\nthird\n" +
    "history\n".repeat(198),
} as const;

/** Explicit disposable opt-in roots, shared by host orchestration and trusted Worker composition. */
export const applicationLifecycleRoots: readonly string[] = [
  applicationLifecycleFixture.root,
  applicationLifecycleFixture.privateRoot,
  applicationLifecycleFixture.concurrentRoot,
  applicationLifecycleFixture.lostRoot,
  applicationLifecycleFixture.crashRoot,
  applicationLifecycleFixture.legacyRoot,
];

/** Disposable runtime-fact roots created and resolved through the signed SDK during local acceptance. */
export const applicationRuntimeFixture = {
  root: "FactsMainRoot01",
  privateRoot: "FactPrivateRoot01",
  pageRoot: "FactPageRoot01",
  initial: "# Runtime facts\nSDK-created branch content\n",
  privateInitial: "# Private runtime facts\nowner only\n",
  pageFactCount: 201,
} as const;

/** Only these synthetic roots may select the optional runtime-fact capability in the fixture. */
export const applicationRuntimeRoots: readonly string[] = [
  applicationRuntimeFixture.root,
  applicationRuntimeFixture.privateRoot,
  applicationRuntimeFixture.pageRoot,
];

/** Local bootstrap allowlist; the original lifecycle scenario's root set stays independent. */
export const applicationUnseededRoots: readonly string[] = [
  ...applicationLifecycleRoots,
  ...applicationRuntimeRoots,
];

/** Inspects one synthetic stored root without trusting permissive envelope decoding to exclude plaintext. */
export function inspectApplicationRootStorage(
  raw: string,
  expectedContent?: string,
) {
  const parsed: unknown = JSON.parse(raw);
  const envelope = decodeDropEnvelope(parsed);
  const allowed = new Set([
    "schema",
    "version",
    "createdAt",
    "accountId",
    "visibility",
    "unlockPolicy",
    "metadata",
    "cipher",
    "draftCipher",
    "keyEnvelope",
    "deviceSignerPublicJwk",
    "deviceDelegation",
    "providerEscrow",
    "signatures",
  ]);
  const unexpectedFields: string[] = [];
  let containsPlaintext = Boolean(
    expectedContent &&
    (raw.includes(expectedContent) ||
      raw.includes(JSON.stringify(expectedContent).slice(1, -1))),
  );
  const visit = (value: unknown, path: string, depth: number) => {
    if (depth > 32) throw Error("Fixture envelope inspection depth exceeded");
    if (typeof value === "string") {
      if (expectedContent && value.includes(expectedContent))
        containsPlaintext = true;
    } else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (
          (path === "" && !allowed.has(key)) ||
          ["content", "plaintext", "plainText", "draftPack"].includes(key)
        )
          unexpectedFields.push(`${path}/${key}`);
        visit(child, `${path}/${key}`, depth + 1);
      }
    }
  };
  visit(parsed, "", 0);
  return { sealed: envelope !== null, containsPlaintext, unexpectedFields };
}

/** Dependency accounting scopes; fixture setup is reported separately from HTTP requests. */
export type ApplicationRequestPhase =
  | "baseline"
  | "root-create"
  | "root-read"
  | "bootstrap"
  | "steady-state"
  | "runtime-facts"
  | "legacy";

/** Fixture setup data; production initialization and lifecycle remain outside this test. */
export function applicationSeed(
  branchId: string = applicationFixture.branch,
  rootDropId: string = applicationFixture.root,
  content: string = applicationFixture.initial,
): MemoryBranchStateSeed {
  return {
    branch: {
      version: 1,
      rootDropId,
      baseDropId: rootDropId,
      branchId,
      mode: "owner",
      status: "active",
      ownerAccountId: applicationFixture.owner,
      writerAccountId: applicationFixture.writer,
      writerClientId: null,
      headSnapshotId: 0,
      headEventSeq: -1,
      snapshotHeapVersion: 2,
      checkpointInterval: 24,
      createdAt: 1000,
      updatedAt: 1000,
    },
    placement: { ...applicationFixture.placement },
    content,
  };
}

/** Stable synthetic wire event; retries reuse every identity field. */
export function applicationEvent(
  eventId: string,
  ops: DropDiffOp[],
  followsSeq?: number,
  sourceClientId = "client-A",
  dropId: string = applicationFixture.root,
): DropDiffEvent {
  return {
    eventId,
    seq: 0,
    dropId,
    sourceClientId,
    createdAt: 1700000000000,
    ops,
    ...(followsSeq === undefined ? {} : { metadata: { followsSeq } }),
  };
}

/** Frozen hand-authored edits and expected content, independent of server replay helpers. */
export const applicationEdits = {
  green: applicationEvent(
    "edit-green",
    [
      { type: "delete", start: 8, end: 11, text: "red" },
      { type: "insert", start: 8, end: 8, text: "green" },
    ],
    -1,
  ),
  second: applicationEvent(
    "edit-second",
    [{ type: "insert", start: 19, end: 19, text: "client B\n" }],
    0,
    "client-B",
  ),
  batch: [
    applicationEvent(
      "batch-note",
      [{ type: "insert", start: 0, end: 0, text: "Note\n" }],
      1,
    ),
    applicationEvent(
      "batch-done",
      [{ type: "insert", start: 33, end: 33, text: "done\n" }],
      2,
    ),
  ],
  saved: applicationEvent(
    "lost-ack-saved",
    [{ type: "insert", start: 38, end: 38, text: "saved\n" }],
    3,
  ),
  later: applicationEvent(
    "intervening-later",
    [{ type: "insert", start: 44, end: 44, text: "later\n" }],
    4,
    "client-B",
  ),
};

/** Bounded request evidence emitted only by the local application fixture. */
export interface ApplicationRequestEvidence {
  requestId: string;
  phase: ApplicationRequestPhase;
  status: number;
  calls: Record<string, { count: number; errors: number }>;
  rpcFailures: { method: string; code: string }[];
  factCommits?: { identityHash: string; seq: number; appended: boolean }[];
  sqlReads: number;
  sqlWrites: number;
  background: { scheduled: number; completed: number; failed: number };
  observers: {
    id: string;
    snapshotId: number;
    parentSnapshotId: number | null;
    eventIds: string[];
    sequences: number[];
    textLength: number;
    contentHash: string;
  }[];
  observerFailures: number;
  handlerMs: number;
  totalMs: number;
}

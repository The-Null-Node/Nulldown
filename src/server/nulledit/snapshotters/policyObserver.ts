import type { DropDiffEvent } from "../../../../shared/drop/diff";
import type {
  VoidDataIndexEntry,
  VoidDataKey,
  VoidDataPutRecord,
} from "../../ports";
import type {
  NulleditNextRequest,
  NulleditNextResult,
  NulleditPolicyDecisionFactRecord,
  NulleditSnapshotContext,
  NulleditSnapshotter,
} from "../types";

/** Creates the portable data key for one policy decision fact record. */
export const createNulleditPolicyDecisionFactDataKey = (
  fact: Pick<
    NulleditPolicyDecisionFactRecord,
    "rootDropId" | "branchId" | "snapshotId" | "factId"
  >,
): VoidDataKey => ({
  namespace: "nulledit",
  collection: "policy_decision_facts",
  scope: {
    rootDropId: fact.rootDropId,
    branchId: fact.branchId,
    snapshotId: fact.snapshotId,
  },
  id: fact.factId,
});

const eventHasPolicyEvidence = (event: DropDiffEvent): boolean =>
  Boolean(event.metadata?.policyDecisionRef) ||
  event.metadata?.kind === "policy.decision";

const policyDecisionFactText = (
  event: DropDiffEvent,
  factId: string,
): string => {
  const parts = [
    `Policy evidence ${factId} from diff ${event.eventId}.`,
    event.metadata?.policyDecisionRef
      ? `Decision ref: ${event.metadata.policyDecisionRef}.`
      : null,
    event.metadata?.kind ? `Kind: ${event.metadata.kind}.` : null,
    event.metadata?.intent ? `Intent: ${event.metadata.intent}.` : null,
  ];
  return parts.filter(Boolean).join(" ");
};

const createPolicyDecisionFactRecord = (
  context: NulleditSnapshotContext,
  event: DropDiffEvent,
): NulleditPolicyDecisionFactRecord | null => {
  if (!eventHasPolicyEvidence(event)) return null;

  const factId = `policy:diff:${context.rootDropId}:${context.branchId}:${event.eventId}`;
  return {
    version: 1,
    factId,
    rootDropId: context.rootDropId,
    branchId: context.branchId,
    snapshotId: context.snapshotId,
    sourceEventId: event.eventId,
    sourceSeq: event.seq,
    sourceClientId: event.sourceClientId,
    policyDecisionRef: event.metadata?.policyDecisionRef,
    metadataKind: event.metadata?.kind,
    intent: event.metadata?.intent,
    labels: event.metadata?.labels,
    confidence: event.metadata?.confidence,
    args: event.metadata?.args,
    text: policyDecisionFactText(event, factId),
    createdAt: event.createdAt,
  };
};

const pushOptionalIndex = (
  indexes: VoidDataIndexEntry[],
  name: string,
  value: string | number | boolean | null | undefined,
): void => {
  if (value !== undefined) {
    indexes.push({ name, value, mode: "exact" });
  }
};

const policyDecisionFactIndexes = (
  fact: NulleditPolicyDecisionFactRecord,
): VoidDataIndexEntry[] => {
  const indexes: VoidDataIndexEntry[] = [
    { name: "eventId", value: fact.sourceEventId, mode: "exact" },
    { name: "seq", value: fact.sourceSeq, mode: "range" },
    { name: "snapshotId", value: fact.snapshotId, mode: "exact" },
    { name: "text", value: fact.text, mode: "fulltext" },
  ];
  pushOptionalIndex(indexes, "policyDecisionRef", fact.policyDecisionRef);
  pushOptionalIndex(indexes, "kind", fact.metadataKind);
  if (fact.labels?.length) {
    indexes.push({ name: "labels", value: fact.labels, mode: "exact" });
  }
  return indexes;
};

/** Creates the built-in snapshotter that persists accepted diff policy evidence. */
export const createNulleditPolicyObserverSnapshotter =
  (): NulleditSnapshotter => ({
    id: "nulledit.policy-observer",
    phase: "secondary",
    snapshot: async (context) => {
      const facts = context.acceptedEvents
        .map((event) => createPolicyDecisionFactRecord(context, event))
        .filter(
          (fact): fact is NulleditPolicyDecisionFactRecord => fact !== null,
        );
      if (!facts.length) return;

      await context.data.putMany(
        facts.map(
          (fact): VoidDataPutRecord<NulleditPolicyDecisionFactRecord> => ({
            key: createNulleditPolicyDecisionFactDataKey(fact),
            value: fact,
            options: { indexes: policyDecisionFactIndexes(fact) },
          }),
        ),
      );
    },
    yieldNext: (request?: NulleditNextRequest): NulleditNextResult => {
      // TODO: query policy decision facts for this branch
      return { items: [] };
    },
  });

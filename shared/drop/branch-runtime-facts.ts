import type { NullplugUiRuntimeFact } from "../nullplug/ui";
import {
  isNullplugUiRuntimeFact,
  nullplugUiRuntimeFactId,
  nullplugUiResponseFactKey,
  nullplugUiStatePatchFactKey,
  nullplugUiStateSnapshotKey,
} from "../nullplug/ui";
import { isDropBranchRuntimeFact, type DropBranchRuntimeFact } from "./diff";
import {
  BranchStateError,
  BranchStateQuery,
  type BranchHeadQuery,
  type BranchStateHead,
} from "./branch-state";
import { hashNulldownSourceContent } from "./resolved/hash";

/** Authorized request intent captured before routing or asynchronous work. */
export interface BranchRuntimeFactAppendCommand extends BranchHeadQuery {
  actorAccountId: string;
  fact: NullplugUiRuntimeFact;
}

/** Immutable branch-local acknowledgement, independent of the Markdown event timeline. */
export interface BranchRuntimeFactReceipt {
  identity: string;
  payloadHash: string;
  key: string;
  event: DropBranchRuntimeFact;
}

/** Per-call disposition plus the original immutable acknowledgement. */
export interface BranchRuntimeFactAppendResult extends BranchHeadQuery {
  appended: boolean;
  receipt: BranchRuntimeFactReceipt;
}

/** Captured upper bound of an independently sequenced runtime-fact stream. */
export interface BranchRuntimeFactHead extends BranchHeadQuery {
  headSeq: number;
}

/** Bounded ascending read pinned to a previously captured runtime-fact head. */
export interface BranchRuntimeFactPageQuery extends BranchRuntimeFactHead {
  afterSeq: number;
  limit: number;
}

/** Complete contiguous page within the captured horizon; an empty tail has no cursor. */
export interface BranchRuntimeFactPage extends BranchRuntimeFactHead {
  facts: DropBranchRuntimeFact[];
  nextCursor: number | null;
}

/** Branch-local immutable UI facts; implementations own atomic publication and generation fencing. */
export interface BranchRuntimeFactStatePlane {
  appendRuntimeFact(
    command: BranchRuntimeFactAppendCommand,
  ): Promise<BranchRuntimeFactAppendResult>;
  readRuntimeFactHead(query: BranchHeadQuery): Promise<BranchRuntimeFactHead>;
  readRuntimeFacts(
    query: BranchRuntimeFactPageQuery,
  ): Promise<BranchRuntimeFactPage>;
}

/** Durable derived-work intent committed alongside the fact; delivery is a separate capability. */
export interface BranchRuntimeFactOutbox extends BranchHeadQuery {
  id: string;
  kind: "branch.runtime-fact.v1";
  receipt: BranchRuntimeFactReceipt;
}

/** Canonical lossless JSON, rejecting non-JSON inputs and preserving arbitrary own extension keys. */
export function canonicalRuntimeFactJson(value: unknown): string {
  const seen = new Set<object>();
  const visit = (input: unknown): string => {
    if (input === null) return "null";
    if (typeof input === "string" || typeof input === "boolean")
      return JSON.stringify(input);
    if (typeof input === "number" && Number.isFinite(input))
      return JSON.stringify(input);
    if (typeof input !== "object" || input === null || seen.has(input))
      throw new BranchStateError("invalid_command");
    seen.add(input);
    try {
      if (Object.getOwnPropertySymbols(input).length)
        throw new BranchStateError("invalid_command");
      if (Array.isArray(input)) {
        if (Object.keys(input).length !== input.length)
          throw new BranchStateError("invalid_command");
        return `[${Array.from(input, visit).join(",")}]`;
      }
      const prototype = Object.getPrototypeOf(input);
      if (prototype !== null && Object.getPrototypeOf(prototype) !== null)
        throw new BranchStateError("invalid_command");
      return `{${Object.keys(input)
        .sort()
        .map((key) => {
          const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
          if (!("value" in descriptor))
            throw new BranchStateError("invalid_command");
          return `${JSON.stringify(key)}:${visit(descriptor.value)}`;
        })
        .join(",")}}`;
    } finally {
      seen.delete(input);
    }
  };
  return visit(value);
}

/** Exact internal identity; public colon-delimited IDs remain unchanged. */
export function runtimeFactIdentity(fact: NullplugUiRuntimeFact): string {
  return canonicalRuntimeFactJson([
    fact.kind,
    fact.kind === "ui.response" ? fact.primitiveId : fact.callId,
    fact.id,
  ]);
}

/** Existing public storage-key projection, never used as the exact internal identity. */
export function runtimeFactKey(fact: NullplugUiRuntimeFact): string {
  return fact.kind === "ui.response"
    ? nullplugUiResponseFactKey(fact)
    : fact.kind === "ui.state.patch"
      ? nullplugUiStatePatchFactKey(fact)
      : nullplugUiStateSnapshotKey(fact);
}

/** Captures all JSON extensions while overriding actor metadata from authenticated context. */
export function captureRuntimeFactAppend(
  input: BranchRuntimeFactAppendCommand,
): BranchRuntimeFactAppendCommand {
  if (
    !input ||
    typeof input.actorAccountId !== "string" ||
    !input.actorAccountId
  )
    throw new BranchStateError("invalid_command");
  const query = BranchStateQuery.head({
    target: input.target,
    placement: input.placement,
  });
  const fact = JSON.parse(
    canonicalRuntimeFactJson(input.fact),
  ) as NullplugUiRuntimeFact;
  if (
    !isNullplugUiRuntimeFact(fact) ||
    fact.source.rootDropId !== query.target.rootDropId ||
    fact.source.branchId !== query.target.branchId
  )
    throw new BranchStateError("invalid_command");
  fact.metadata = { ...fact.metadata, actorAccountId: input.actorAccountId };
  return { ...query, actorAccountId: input.actorAccountId, fact };
}

/** Immutable retry intent excludes only the two server-assigned fact fields. */
export function runtimeFactIntent(fact: NullplugUiRuntimeFact): string {
  const intent = JSON.parse(canonicalRuntimeFactJson(fact)) as Record<
    string,
    unknown
  >;
  delete intent.createdAt;
  delete (intent.source as Record<string, unknown>).snapshotId;
  return canonicalRuntimeFactJson(intent);
}

/** Hashes canonical JSON rather than raw strings, preserving lone UTF-16 surrogates. */
export function hashRuntimeFactIntent(intent: string): Promise<string> {
  return hashNulldownSourceContent(
    `nulldown.branch-runtime-fact.v1\n${intent}`,
  );
}

/** Validates and captures a finite page without coercion. */
export function captureRuntimeFactPage(
  input: BranchRuntimeFactPageQuery,
): BranchRuntimeFactPageQuery {
  const query = BranchStateQuery.head({
    target: input?.target,
    placement: input?.placement,
  });
  if (
    !Number.isSafeInteger(input.headSeq) ||
    input.headSeq < -1 ||
    !Number.isSafeInteger(input.afterSeq) ||
    input.afterSeq < -1 ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 200
  )
    throw new BranchStateError("invalid_command");
  return {
    ...query,
    headSeq: input.headSeq,
    afterSeq: input.afterSeq,
    limit: input.limit,
  };
}

/** Validates exact persisted/RPC event scope and assigned fields without discarding JSON extensions. */
export function validateRuntimeFactEvent(
  event: DropBranchRuntimeFact,
  query: BranchHeadQuery,
): void {
  try {
    if (
      !isDropBranchRuntimeFact(event) ||
      event.rootDropId !== query.target.rootDropId ||
      event.branchId !== query.target.branchId ||
      event.fact.source.rootDropId !== query.target.rootDropId ||
      event.fact.source.branchId !== query.target.branchId ||
      !Number.isSafeInteger(event.seq) ||
      event.seq < 0 ||
      !Number.isSafeInteger(event.createdAt) ||
      event.createdAt < 0 ||
      event.fact.createdAt !== event.createdAt ||
      !Number.isSafeInteger(event.fact.source.snapshotId) ||
      event.fact.source.snapshotId! < 0 ||
      typeof event.fact.source.sourceContentHash !== "string" ||
      !/^sha256:[A-Za-z0-9_-]{43}$/.test(event.fact.source.sourceContentHash) ||
      typeof event.fact.metadata?.actorAccountId !== "string" ||
      !event.fact.metadata.actorAccountId ||
      event.factId !== nullplugUiRuntimeFactId(event.fact)
    )
      throw Error();
    canonicalRuntimeFactJson(event);
  } catch {
    throw new BranchStateError("state_corrupt");
  }
}

/** Checks persisted/RPC receipt identity; callers additionally verify its canonical payload hash. */
export function validateRuntimeFactReceipt(
  receipt: BranchRuntimeFactReceipt,
  query: BranchHeadQuery,
): void {
  try {
    validateRuntimeFactEvent(receipt?.event, query);
    if (
      receipt.identity !== runtimeFactIdentity(receipt.event.fact) ||
      receipt.key !== runtimeFactKey(receipt.event.fact) ||
      typeof receipt.payloadHash !== "string" ||
      !/^sha256:[A-Za-z0-9_-]{43}$/.test(receipt.payloadHash)
    )
      throw Error();
  } catch {
    throw new BranchStateError("state_corrupt");
  }
}

/** Checks current branch ownership before any replay acknowledgement. */
export function authorizeRuntimeFact(
  command: BranchRuntimeFactAppendCommand,
  head: BranchStateHead,
): void {
  if (
    command.actorAccountId !== head.branch.ownerAccountId &&
    command.actorAccountId !== head.branch.writerAccountId
  )
    throw new BranchStateError("forbidden");
}

/** Prepares a new immutable receipt synchronously against the transaction's actual current head. */
export function prepareRuntimeFactReceipt(
  command: BranchRuntimeFactAppendCommand,
  head: BranchStateHead,
  headSeq: number,
  payloadHash: string,
  now: number,
): BranchRuntimeFactReceipt {
  if (head.branch.status !== "active")
    throw new BranchStateError("branch_not_active");
  if (!command.fact.source.sourceContentHash)
    throw new BranchStateError("source_hash_required");
  if (command.fact.source.sourceContentHash !== head.version.sourceContentHash)
    throw new BranchStateError("stale_source");
  if (!Number.isSafeInteger(now) || now < 0)
    throw new BranchStateError("invalid_command");
  if (!Number.isSafeInteger(headSeq + 1) || headSeq < -1)
    throw new BranchStateError("runtime_fact_sequence_exhausted");
  const fact = {
    ...command.fact,
    createdAt: now,
    source: { ...command.fact.source, snapshotId: head.version.snapshotId },
  };
  return {
    identity: runtimeFactIdentity(fact),
    payloadHash,
    key: runtimeFactKey(fact),
    event: {
      version: 1,
      ...command.target,
      seq: headSeq + 1,
      factId: nullplugUiRuntimeFactId(fact),
      createdAt: now,
      fact,
    },
  };
}

/** Collision-free deterministic outbox intent; no delivery or projection is performed here. */
export function runtimeFactOutbox(
  query: BranchHeadQuery,
  receipt: BranchRuntimeFactReceipt,
): BranchRuntimeFactOutbox {
  return {
    target: query.target,
    placement: query.placement,
    id: canonicalRuntimeFactJson([
      "branch.runtime-fact.v1",
      query.target.rootDropId,
      query.target.branchId,
      query.placement.routingVersion,
      query.placement.generation,
      receipt.identity,
    ]),
    kind: "branch.runtime-fact.v1",
    receipt,
  };
}

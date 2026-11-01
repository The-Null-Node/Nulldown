import { nullMemRecordText } from "../nullmem/capsule";
import type {
  NullMemFactRecord,
  NullMemProcedureRecord,
  NullMemRecord,
} from "../nullmem/records";
import { isNullMemRecord } from "../nullmem/validation";
import { isDropBranchRecord } from "./branch";
import { canonicalRuntimeFactJson } from "./branch-runtime-facts";
import {
  BranchStateError,
  BranchStateQuery,
  type BranchHeadQuery,
  type BranchStateHead,
} from "./branch-state";

/** Persisted branch-local memory writable through the existing fact/procedure API. */
export type BranchNullMemRecord = NullMemFactRecord | NullMemProcedureRecord;

/** Primitive selection captured for one bounded result; implementations may scan the entire branch. */
export interface BranchNullMemSelection {
  kind?: NullMemRecord["kind"];
  q?: string;
  labels?: string[];
  procedureId?: string;
  limit: number;
}

/** Authorized internal query; root visibility remains the application adapter's responsibility. */
export interface BranchNullMemQuery
  extends BranchHeadQuery, BranchNullMemSelection {}

/** One accepted mutable upsert; the actor is trusted context, never record metadata. */
export interface BranchNullMemPutCommand extends BranchHeadQuery {
  actorAccountId: string;
  record: BranchNullMemRecord;
}

/** One accepted deletion of every branch-local kind with this exact record ID. */
export interface BranchNullMemDeleteCommand extends BranchHeadQuery {
  actorAccountId: string;
  recordId: string;
}

/** Transaction-consistent branch head and memory revision shared by internal results. */
export interface BranchNullMemResult extends BranchHeadQuery {
  head: BranchStateHead;
  memoryRevision: number;
}

/** Bounded persisted results; global defaults and application catalogs are not this authority's data. */
export interface BranchNullMemQueryResult extends BranchNullMemResult {
  records: BranchNullMemRecord[];
}

/** Current call's upsert result; retries are new mutations, not immutable acknowledgements. */
export interface BranchNullMemPutResult extends BranchNullMemResult {
  record: BranchNullMemRecord;
}

/** Current call's deletion result, including successful deletion of an absent ID. */
export interface BranchNullMemDeleteResult extends BranchNullMemResult {
  recordId: string;
}

/** Branch-local mutable memory authority implemented by memory, SQLite and internal Worker RPC. */
export interface BranchNullMemStatePlane {
  queryNullMem(query: BranchNullMemQuery): Promise<BranchNullMemQueryResult>;
  putNullMem(command: BranchNullMemPutCommand): Promise<BranchNullMemPutResult>;
  deleteNullMem(
    command: BranchNullMemDeleteCommand,
  ): Promise<BranchNullMemDeleteResult>;
}

/** Durable revision-keyed derived-work intent; publication is atomic, delivery is a separate capability. */
export type BranchNullMemOutbox = {
  kind: "branch.nullmem.v1";
  id: string;
  actorAccountId: string;
  createdAt: number;
  intent: string;
} & (
  | { operation: "put"; result: BranchNullMemPutResult }
  | { operation: "delete"; result: BranchNullMemDeleteResult }
);

const invalid = (): never => {
  throw new BranchStateError("invalid_command");
};
const corrupt = (): never => {
  throw new BranchStateError("state_corrupt");
};

/** Captures lossless JSON extensions, omitting object undefined and mapping array undefined to null as JSON does. */
export function captureNullMemJson(value: unknown): string {
  const seen = new Set<object>();
  const visit = (input: unknown): unknown => {
    if (
      input === null ||
      typeof input === "string" ||
      typeof input === "boolean"
    )
      return input;
    if (typeof input === "number")
      return Number.isFinite(input) ? input : invalid();
    if (!input || typeof input !== "object" || seen.has(input))
      return invalid();
    if (Object.getOwnPropertySymbols(input).length) return invalid();
    const prototype = Object.getPrototypeOf(input);
    if (
      !Array.isArray(input) &&
      prototype !== null &&
      Object.getPrototypeOf(prototype) !== null
    )
      return invalid();
    seen.add(input);
    try {
      if (Array.isArray(input)) {
        if (
          Object.keys(input).some(
            (key) =>
              !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= input.length,
          )
        )
          return invalid();
        return Array.from({ length: input.length }, (_, index) => {
          const descriptor = Object.getOwnPropertyDescriptor(
            input,
            String(index),
          );
          if (descriptor && !("value" in descriptor)) return invalid();
          return descriptor?.value === undefined
            ? null
            : visit(descriptor.value);
        });
      }
      const result = Object.create(null) as Record<string, unknown>;
      for (const key of Object.keys(input)) {
        const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
        if (!("value" in descriptor)) return invalid();
        if (descriptor.value !== undefined)
          result[key] = visit(descriptor.value);
      }
      return result;
    } finally {
      seen.delete(input);
    }
  };
  return canonicalRuntimeFactJson(visit(value));
}

/** Validates primitive filters without coercion and detaches label arrays before asynchronous routing. */
export function captureNullMemSelection(
  input: BranchNullMemSelection,
): BranchNullMemSelection {
  if (
    !input ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 100 ||
    (input.kind !== undefined &&
      !["fact", "procedure", "capability"].includes(input.kind)) ||
    (input.q !== undefined && typeof input.q !== "string") ||
    (input.procedureId !== undefined &&
      typeof input.procedureId !== "string") ||
    (input.labels !== undefined &&
      (!Array.isArray(input.labels) ||
        Array.from(input.labels).some((label) => typeof label !== "string")))
  )
    return invalid();
  return {
    kind: input.kind,
    q: input.q,
    labels: input.labels ? [...input.labels] : undefined,
    procedureId: input.procedureId,
    limit: input.limit,
  };
}

/** Captures one branch-local query before routing; absence of a kind does not request legacy global defaults. */
export function captureNullMemQuery(
  input: BranchNullMemQuery,
): BranchNullMemQuery {
  return {
    ...BranchStateQuery.head({
      target: input?.target,
      placement: input?.placement,
    }),
    ...captureNullMemSelection(input),
  };
}

/** Selects stable top-N after every lexical, label, kind and exact-procedure filter; scans all supplied records. */
export function queryNullMemRecords<T extends NullMemRecord>(
  records: Iterable<T>,
  input: BranchNullMemSelection,
): T[] {
  const selection = captureNullMemSelection(input);
  const tokens =
    selection.q
      ?.toLowerCase()
      .match(/[a-z0-9]+/g)
      ?.filter((token) => token.length > 1) ?? [];
  const compare = (a: T, b: T) =>
    // Preserve public score arithmetic: adding the matched-token count can round tiny priorities into ties.
    tokens.length + (b.priority ?? 0) - (tokens.length + (a.priority ?? 0)) ||
    b.createdAt - a.createdAt ||
    a.recordId.localeCompare(b.recordId);
  const selected: T[] = [];
  for (const record of records) {
    if (selection.kind !== undefined && record.kind !== selection.kind)
      continue;
    if (
      selection.procedureId !== undefined &&
      (record.kind !== "procedure" || record.recordId !== selection.procedureId)
    )
      continue;
    if (
      !(selection.labels ?? []).every((label) =>
        (record.labels ?? []).includes(label),
      )
    )
      continue;
    const text = nullMemRecordText(record).toLowerCase();
    if (!tokens.every((token) => text.includes(token))) continue;
    const index = selected.findIndex((other) => compare(record, other) < 0);
    if (index < 0) {
      if (selected.length < selection.limit) selected.push(record);
    } else {
      selected.splice(index, 0, record);
      if (selected.length > selection.limit) selected.pop();
    }
  }
  return selected;
}

/** Exact persisted identity; kind and ID are separate tuple members, including lone UTF-16 surrogates. */
export function nullMemRecordIdentity(record: BranchNullMemRecord): string {
  return JSON.stringify([record.kind, record.recordId]);
}

/** Checks writable record kind and exact scope without stripping historical JSON extension fields. */
export function validateNullMemRecord(
  record: unknown,
  query: BranchHeadQuery,
): asserts record is BranchNullMemRecord {
  if (
    !isNullMemRecord(record) ||
    record.kind === "capability" ||
    record.rootDropId !== query.target.rootDropId ||
    record.branchId !== query.target.branchId
  )
    return invalid();
  canonicalRuntimeFactJson(record);
}

/** Captures one upsert before any await, preserving caller metadata and optional JSON serialization behavior. */
export function captureNullMemPut(
  input: BranchNullMemPutCommand,
): BranchNullMemPutCommand {
  const query = BranchStateQuery.head({
    target: input?.target,
    placement: input?.placement,
  });
  if (typeof input.actorAccountId !== "string" || !input.actorAccountId)
    return invalid();
  const record: unknown = JSON.parse(captureNullMemJson(input.record));
  validateNullMemRecord(record, query);
  return { ...query, actorAccountId: input.actorAccountId, record };
}

/** Captures one delete without trimming, URI decoding or restricting the existing string identity domain. */
export function captureNullMemDelete(
  input: BranchNullMemDeleteCommand,
): BranchNullMemDeleteCommand {
  const query = BranchStateQuery.head({
    target: input?.target,
    placement: input?.placement,
  });
  if (
    typeof input.actorAccountId !== "string" ||
    !input.actorAccountId ||
    typeof input.recordId !== "string"
  )
    return invalid();
  return {
    ...query,
    actorAccountId: input.actorAccountId,
    recordId: input.recordId,
  };
}

/** Rechecks the authenticated actor against the transaction's actual owner/writer; no status or source-hash gate. */
export function authorizeNullMem(
  command: { actorAccountId: string },
  head: BranchStateHead,
): void {
  if (
    command.actorAccountId !== head.branch.ownerAccountId &&
    command.actorAccountId !== head.branch.writerAccountId
  )
    throw new BranchStateError("forbidden");
}

/** Canonical raw upsert intent excludes only backend-assigned createdAt, not caller metadata or updatedAt. */
export function nullMemRecordIntent(record: BranchNullMemRecord): string {
  const value = JSON.parse(captureNullMemJson(record));
  delete value.createdAt;
  return canonicalRuntimeFactJson(value);
}

/** Checks exact result scope and coherent captured branch/version fields at persistence and RPC boundaries. */
export function validateNullMemResult(
  value: BranchNullMemResult,
  query: BranchHeadQuery,
): void {
  try {
    const sameScope = (actual: BranchHeadQuery) =>
      canonicalRuntimeFactJson(actual.target) ===
        canonicalRuntimeFactJson(query.target) &&
      canonicalRuntimeFactJson(actual.placement) ===
        canonicalRuntimeFactJson(query.placement);
    if (
      !value ||
      !sameScope(value) ||
      !sameScope(value.head) ||
      !Number.isSafeInteger(value.memoryRevision) ||
      value.memoryRevision < 0 ||
      !isDropBranchRecord(value.head.branch)
    )
      return corrupt();
    const head = value.head;
    BranchStateQuery.content({
      target: head.target,
      placement: head.placement,
      version: head.version,
    });
    if (
      head.branch.rootDropId !== query.target.rootDropId ||
      head.branch.branchId !== query.target.branchId ||
      head.branch.headSnapshotId !== head.version.snapshotId ||
      head.branch.headEventSeq !== head.version.eventSeq ||
      (head.version.snapshotId === 0
        ? head.version.eventSeq !== -1
        : head.version.eventSeq < head.version.snapshotId - 1)
    )
      return corrupt();
    captureNullMemJson(value);
  } catch {
    return corrupt();
  }
}

/** Validates a bounded RPC selection, exact identities, assigned timestamps and stable ordering before exposure. */
export function validateNullMemQueryResult(
  value: BranchNullMemQueryResult,
  query: BranchNullMemQuery,
): void {
  try {
    validateNullMemResult(value, query);
    if (
      !Array.isArray(value.records) ||
      value.records.length > query.limit ||
      (value.memoryRevision === 0 && value.records.length)
    )
      return corrupt();
    const ids = new Set<string>();
    for (const record of value.records) {
      validateNullMemRecord(record, query);
      const id = nullMemRecordIdentity(record);
      if (
        ids.has(id) ||
        !Number.isSafeInteger(record.createdAt) ||
        record.createdAt < 0
      )
        return corrupt();
      ids.add(id);
    }
    if (
      canonicalRuntimeFactJson(queryNullMemRecords(value.records, query)) !==
      canonicalRuntimeFactJson(value.records)
    )
      return corrupt();
  } catch {
    return corrupt();
  }
}

/** Verifies one fresh upsert response against complete raw intent, excluding only the assigned timestamp. */
export function validateNullMemPutResult(
  value: BranchNullMemPutResult,
  command: BranchNullMemPutCommand,
): void {
  try {
    validateNullMemResult(value, command);
    validateNullMemRecord(value.record, command);
    authorizeNullMem(command, value.head);
    if (
      value.memoryRevision < 1 ||
      !Number.isSafeInteger(value.record.createdAt) ||
      value.record.createdAt < 0 ||
      nullMemRecordIntent(value.record) !== nullMemRecordIntent(command.record)
    )
      return corrupt();
  } catch {
    return corrupt();
  }
}

/** Verifies exact delete identity and the authorized transaction head, including absent-record success. */
export function validateNullMemDeleteResult(
  value: BranchNullMemDeleteResult,
  command: BranchNullMemDeleteCommand,
): void {
  try {
    validateNullMemResult(value, command);
    authorizeNullMem(command, value.head);
    if (value.memoryRevision < 1 || value.recordId !== command.recordId)
      return corrupt();
  } catch {
    return corrupt();
  }
}

/** Prepares an accepted put and durable intent synchronously within the publication transaction. */
export function prepareNullMemPut(
  command: BranchNullMemPutCommand,
  head: BranchStateHead,
  revision: number,
  now: number,
): BranchNullMemOutbox & { operation: "put" } {
  const result: BranchNullMemPutResult = {
    target: command.target,
    placement: command.placement,
    head,
    memoryRevision: revision + 1,
    record: { ...command.record, createdAt: now },
  };
  return makeOutbox(command.actorAccountId, now, {
    operation: "put",
    result,
  }) as BranchNullMemOutbox & { operation: "put" };
}

/** Prepares an accepted delete, including absent IDs, without publishing any partial state. */
export function prepareNullMemDelete(
  command: BranchNullMemDeleteCommand,
  head: BranchStateHead,
  revision: number,
  now: number,
): BranchNullMemOutbox & { operation: "delete" } {
  const result: BranchNullMemDeleteResult = {
    target: command.target,
    placement: command.placement,
    head,
    memoryRevision: revision + 1,
    recordId: command.recordId,
  };
  return makeOutbox(command.actorAccountId, now, {
    operation: "delete",
    result,
  }) as BranchNullMemOutbox & { operation: "delete" };
}

const outboxId = (result: BranchNullMemResult) =>
  JSON.stringify([
    "branch.nullmem.v1",
    result.target.rootDropId,
    result.target.branchId,
    result.placement.routingVersion,
    result.placement.generation,
    result.memoryRevision,
  ]);
const makeOutbox = (
  actorAccountId: string,
  createdAt: number,
  mutation:
    | Pick<
        Extract<BranchNullMemOutbox, { operation: "put" }>,
        "operation" | "result"
      >
    | Pick<
        Extract<BranchNullMemOutbox, { operation: "delete" }>,
        "operation" | "result"
      >,
): BranchNullMemOutbox => {
  if (
    !Number.isSafeInteger(createdAt) ||
    createdAt < 0 ||
    !Number.isSafeInteger(mutation.result.memoryRevision) ||
    mutation.result.memoryRevision < 1
  )
    return invalid();
  return {
    ...mutation,
    kind: "branch.nullmem.v1",
    actorAccountId,
    createdAt,
    id: outboxId(mutation.result),
    intent:
      mutation.operation === "put"
        ? nullMemRecordIntent(mutation.result.record)
        : JSON.stringify(mutation.result.recordId),
  };
};

/**
 * Validates every revision and reconstructs current records; lost, orphaned or altered rows fail closed.
 * Work and temporary memory grow with total mutation history plus current records, not the query limit.
 * This initial integrity contract supplies bounded responses, not bounded scan or publication latency.
 */
export function validateNullMemState(
  head: BranchStateHead,
  revision: number,
  records: readonly BranchNullMemRecord[],
  outbox: readonly BranchNullMemOutbox[],
): void {
  try {
    validateNullMemResult(
      {
        target: head.target,
        placement: head.placement,
        head,
        memoryRevision: revision,
      },
      head,
    );
    if (outbox.length !== revision) return corrupt();
    const expected = new Map<string, BranchNullMemRecord>();
    let previousSnapshot = 0;
    let previousEvent = -1;
    for (const [index, entry] of outbox.entries()) {
      validateNullMemResult(entry.result, head);
      if (
        entry.kind !== "branch.nullmem.v1" ||
        entry.result.memoryRevision !== index + 1 ||
        entry.id !== outboxId(entry.result) ||
        !Number.isSafeInteger(entry.createdAt) ||
        entry.createdAt < 0 ||
        typeof entry.actorAccountId !== "string" ||
        !entry.actorAccountId ||
        entry.result.head.version.snapshotId > head.version.snapshotId ||
        entry.result.head.version.eventSeq > head.version.eventSeq ||
        entry.result.head.version.snapshotId < previousSnapshot ||
        entry.result.head.version.eventSeq < previousEvent
      )
        return corrupt();
      authorizeNullMem(entry, entry.result.head);
      previousSnapshot = entry.result.head.version.snapshotId;
      previousEvent = entry.result.head.version.eventSeq;
      if (entry.operation === "put") {
        validateNullMemRecord(entry.result.record, head);
        if (
          entry.result.record.createdAt !== entry.createdAt ||
          entry.intent !== nullMemRecordIntent(entry.result.record)
        )
          return corrupt();
        expected.set(
          nullMemRecordIdentity(entry.result.record),
          entry.result.record,
        );
      } else if (
        entry.operation === "delete" &&
        typeof entry.result.recordId === "string"
      ) {
        if (entry.intent !== JSON.stringify(entry.result.recordId))
          return corrupt();
        for (const [id, record] of expected)
          if (record.recordId === entry.result.recordId) expected.delete(id);
      } else return corrupt();
    }
    if (expected.size !== records.length) return corrupt();
    for (const record of records) {
      validateNullMemRecord(record, head);
      const id = nullMemRecordIdentity(record);
      if (
        !expected.has(id) ||
        canonicalRuntimeFactJson(expected.get(id)) !==
          canonicalRuntimeFactJson(record)
      )
        return corrupt();
      expected.delete(id);
    }
  } catch {
    return corrupt();
  }
}

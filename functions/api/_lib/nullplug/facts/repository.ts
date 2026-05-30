import {
  isNullplugUiResponseFact,
  isNullplugUiStatePatchFact,
  isNullplugUiStateSnapshot,
  nullplugUiResponseFactKey,
  nullplugUiResponseFactPrefix,
  nullplugUiStatePatchFactKey,
  nullplugUiStatePatchFactPrefix,
  nullplugUiStateSnapshotKey,
  nullplugUiStateSnapshotPrefix,
  type NullplugUiResponseFact,
  type NullplugUiStatePatchFact,
  type NullplugUiStateSnapshot,
} from "../../../../../shared/nullplug/ui";
import type { VoidBlobStore, VoidSqlStore } from "../../../../../src/server/ports";
import { parseJsonColumn } from "../../core/d1/metadata";

type NullplugFactKind = "ui.response" | "ui.state.patch" | "ui.state.snapshot";

const scopeValue = (value?: string): string => value ?? "";

const writeFactToD1 = async (
  db: VoidSqlStore | undefined,
  kind: NullplugFactKind,
  fact:
    | NullplugUiResponseFact
    | NullplugUiStatePatchFact
    | NullplugUiStateSnapshot,
): Promise<void> => {
  if (!db) return;

  const callId = "callId" in fact ? fact.callId : fact.source.callId;
  const factId =
    fact.kind === "ui.response" ? `${fact.primitiveId}/${fact.id}` : fact.id;
  await db
    .prepare(
      `INSERT OR IGNORE INTO nullplug_facts (
         fact_kind, root_drop_id, branch_id, call_id, fact_id, created_at, fact_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      kind,
      fact.source.rootDropId,
      scopeValue(fact.source.branchId),
      scopeValue(callId),
      factId,
      fact.createdAt,
      JSON.stringify(fact),
    )
    .run();
};

/** Writes a UI response fact into D1 metadata storage without touching R2. */
export const syncNullplugUiResponseFactToD1 = async (
  db: VoidSqlStore | undefined,
  fact: NullplugUiResponseFact,
): Promise<void> => writeFactToD1(db, "ui.response", fact);

/** Writes a UI state fact into D1 metadata storage without touching R2. */
export const syncNullplugUiStateFactToD1 = async (
  db: VoidSqlStore | undefined,
  fact: NullplugUiStatePatchFact | NullplugUiStateSnapshot,
): Promise<void> => writeFactToD1(db, fact.kind, fact);

const listFactsFromD1 = async <T>(
  db: VoidSqlStore | undefined,
  kind: NullplugFactKind,
  rootDropId: string,
  branchId: string | undefined,
  guard: (value: unknown) => value is T,
): Promise<T[]> => {
  if (!db) return [];

  const rows = await db
    .prepare(
      `SELECT fact_json
       FROM nullplug_facts
       WHERE fact_kind = ? AND root_drop_id = ? AND branch_id = ?
       ORDER BY created_at ASC`,
    )
    .bind(kind, rootDropId, scopeValue(branchId))
    .all<{ fact_json: string }>();

  return (rows.results ?? [])
    .map((row) => parseJsonColumn(row.fact_json, guard))
    .filter((entry): entry is T => Boolean(entry));
};

const listJsonByPrefix = async <T>(
  bucket: VoidBlobStore,
  prefix: string,
  guard: (value: unknown) => value is T,
): Promise<T[]> => {
  const items: T[] = [];
  let cursor: string | undefined;

  do {
    const listed = await bucket.list({ prefix, cursor, limit: 1000 });
    const values = await Promise.all(
      listed.objects.map(async (object) => {
        try {
          const stored = await bucket.get(object.key);
          if (!stored) return null;

          const parsed = await stored.json();
          return guard(parsed) ? parsed : null;
        } catch {
          return null;
        }
      }),
    );
    values.forEach((value) => {
      if (value) items.push(value);
    });
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  return items;
};

/** Lists persisted UI response facts for a root drop or branch. */
export const listNullplugUiResponseFacts = async (
  bucket: VoidBlobStore,
  rootDropId: string,
  branchId?: string,
  db?: VoidSqlStore,
): Promise<NullplugUiResponseFact[]> => {
  const facts = await listFactsFromD1(
    db,
    "ui.response",
    rootDropId,
    branchId,
    isNullplugUiResponseFact,
  );
  if (facts.length > 0) return facts;

  return listJsonByPrefix(
    bucket,
    nullplugUiResponseFactPrefix(rootDropId, branchId),
    isNullplugUiResponseFact,
  );
};

/** Lists persisted UI state patch facts for a root drop or branch. */
export const listNullplugUiStatePatchFacts = async (
  bucket: VoidBlobStore,
  rootDropId: string,
  branchId?: string,
  db?: VoidSqlStore,
): Promise<NullplugUiStatePatchFact[]> => {
  const facts = await listFactsFromD1(
    db,
    "ui.state.patch",
    rootDropId,
    branchId,
    isNullplugUiStatePatchFact,
  );
  if (facts.length > 0) return facts;

  return listJsonByPrefix(
    bucket,
    nullplugUiStatePatchFactPrefix(rootDropId, branchId),
    isNullplugUiStatePatchFact,
  );
};

/** Lists persisted UI state snapshots for a root drop or branch. */
export const listNullplugUiStateSnapshots = async (
  bucket: VoidBlobStore,
  rootDropId: string,
  branchId?: string,
  db?: VoidSqlStore,
): Promise<NullplugUiStateSnapshot[]> => {
  const facts = await listFactsFromD1(
    db,
    "ui.state.snapshot",
    rootDropId,
    branchId,
    isNullplugUiStateSnapshot,
  );
  if (facts.length > 0) return facts;

  return listJsonByPrefix(
    bucket,
    nullplugUiStateSnapshotPrefix(rootDropId, branchId),
    isNullplugUiStateSnapshot,
  );
};

/** Writes a UI response fact to R2 and D1 metadata storage. */
export const putNullplugUiResponseFact = async (
  bucket: VoidBlobStore,
  fact: NullplugUiResponseFact,
  db?: VoidSqlStore,
): Promise<{ key: string; written: boolean }> => {
  const key = nullplugUiResponseFactKey(fact);
  const written = await bucket.put(key, JSON.stringify(fact), {
    httpMetadata: { contentType: "application/json" },
    onlyIf: { etagDoesNotMatch: "*" },
  });
  if (!written) return { key, written: false };

  await writeFactToD1(db, "ui.response", fact);
  return { key, written: true };
};

/** Writes a UI state fact to R2 and D1 metadata storage. */
export const putNullplugUiStateFact = async (
  bucket: VoidBlobStore,
  fact: NullplugUiStatePatchFact | NullplugUiStateSnapshot,
  db?: VoidSqlStore,
): Promise<{ key: string; written: boolean }> => {
  const key =
    fact.kind === "ui.state.patch"
      ? nullplugUiStatePatchFactKey(fact)
      : nullplugUiStateSnapshotKey(fact);
  const written = await bucket.put(key, JSON.stringify(fact), {
    httpMetadata: { contentType: "application/json" },
    onlyIf: { etagDoesNotMatch: "*" },
  });
  if (!written) return { key, written: false };

  await writeFactToD1(db, fact.kind, fact);
  return { key, written: true };
};

/** Reads all nullplug runtime facts used by resolved runtime heap materialization. */
export const listNullplugRuntimeFacts = async (
  bucket: VoidBlobStore,
  rootDropId: string,
  branchId?: string,
  db?: VoidSqlStore,
): Promise<{
  uiResponseFacts: NullplugUiResponseFact[];
  uiStatePatchFacts: NullplugUiStatePatchFact[];
  uiStateSnapshots: NullplugUiStateSnapshot[];
}> => {
  const [uiResponseFacts, uiStatePatchFacts, uiStateSnapshots] =
    await Promise.all([
      listNullplugUiResponseFacts(bucket, rootDropId, branchId, db),
      listNullplugUiStatePatchFacts(bucket, rootDropId, branchId, db),
      listNullplugUiStateSnapshots(bucket, rootDropId, branchId, db),
    ]);

  return { uiResponseFacts, uiStatePatchFacts, uiStateSnapshots };
};

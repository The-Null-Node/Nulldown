import {
  isDropBranchRecord,
  isDropSnapshotRecord,
} from "../../../../../../shared/drop/branch";
import { isDropDiffEvent } from "../../../../../../shared/drop/diff";
import { DROP_RESOLVED_HEAP_KEY_PREFIX } from "../../../../../../shared/drop/sidecar";
import { isResolvedNulldownState } from "../../../../../../shared/drop/resolved/validators";
import {
  isNullplugUiResponseFact,
  isNullplugUiStatePatchFact,
  isNullplugUiStateSnapshot,
  NULLPLUG_UI_RESPONSE_FACT_KEY_PREFIX,
  NULLPLUG_UI_STATE_PATCH_FACT_KEY_PREFIX,
  NULLPLUG_UI_STATE_SNAPSHOT_KEY_PREFIX,
} from "../../../../../../shared/nullplug/ui";
import { isAccountRecord } from "../../../accounts/identity/records";
import {
  ACCOUNT_RECORD_PREFIX,
  putAccountRecord,
} from "../../../accounts/identity/repository";
import {
  createDropIdentityRepository,
  REMOTE_DROP_ALIAS_PREFIX,
} from "../../../drops/identity/id";
import {
  isRemotePublicDropIndexKey,
  readPublicDropIndexEntryByKey,
  upsertPublicDropIndexEntry,
} from "../../../drops/index/repository";
import {
  BRANCH_DIFF_EVENT_KEY_PREFIX,
  BRANCH_KEY_PREFIX,
  SNAPSHOT_KEY_PREFIX,
  WRITER_BRANCH_KEY_PREFIX,
} from "../../../branches/storage/keys";
import {
  createBranchRepository,
  readR2Json,
} from "../../../branches/storage/repository";
import { createBranchDiffRepository } from "../../../branches/storage/diff-log";
import {
  createDiffCredentialRepository,
  DIFF_AUTH_KEY_PREFIX,
  isDiffAuthCredentialRecord,
} from "../../../diffs/credentials/repository";
import {
  syncNullplugUiResponseFactToD1,
  syncNullplugUiStateFactToD1,
} from "../../../nullplug/facts/repository";
import { syncResolvedStateToD1 } from "../../../resolved/heap/service";
import type { MetadataBackfillEnv, MetadataBackfillStats } from "./contracts";
import { projectDropObject } from "./drop-projection";

const stripSuffix = (value: string, suffix: string): string =>
  value.endsWith(suffix) ? value.slice(0, -suffix.length) : value;

const readObjectText = async (
  object: { text: () => Promise<string> } | null,
): Promise<string | null> => {
  if (!object) return null;
  const value = (await object.text()).trim();
  return value || null;
};

const readObjectJson = async <T>(
  object: { json: <U = unknown>() => Promise<U> } | null,
  guard: (value: unknown) => value is T,
): Promise<T | null> => {
  if (!object) return null;
  try {
    const parsed = await object.json<unknown>();
    return guard(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const upsertWriterPointer = async (
  env: Required<Pick<MetadataBackfillEnv, "R2_BUCKET" | "DB">>,
  key: string,
  branchId: string,
): Promise<boolean> => {
  const rest = key.slice(WRITER_BRANCH_KEY_PREFIX.length);
  const slashIndex = rest.indexOf("/");
  if (slashIndex <= 0) return false;

  const rootDropId = rest.slice(0, slashIndex);
  const writerKey = stripSuffix(rest.slice(slashIndex + 1), ".txt");
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO branch_writers (root_drop_id, writer_key, branch_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(root_drop_id, writer_key) DO UPDATE SET
         branch_id = excluded.branch_id,
         updated_at = excluded.updated_at`,
  )
    .bind(rootDropId, writerKey, branchId, now, now)
    .run();
  return true;
};

const projectInternalObject = async (
  env: Required<Pick<MetadataBackfillEnv, "R2_BUCKET" | "DB">>,
  key: string,
  stats: MetadataBackfillStats,
): Promise<boolean> => {
  if (key.startsWith(REMOTE_DROP_ALIAS_PREFIX)) {
    const fullId = await readObjectText(await env.R2_BUCKET.get(key));
    if (!fullId) {
      stats.invalid += 1;
      return true;
    }
    const repository = createDropIdentityRepository({
      blobs: env.R2_BUCKET,
      sql: env.DB,
    });
    await repository.writeRemoteAliasToD1(
      key.slice(REMOTE_DROP_ALIAS_PREFIX.length),
      fullId,
    );
    stats.aliasesUpserted += 1;
    return true;
  }

  if (isRemotePublicDropIndexKey(key)) {
    const entry = await readPublicDropIndexEntryByKey(env.R2_BUCKET, key);
    if (!entry) {
      stats.invalid += 1;
      return true;
    }
    await upsertPublicDropIndexEntry(
      env.R2_BUCKET,
      entry.id,
      entry.updatedAt,
      env.DB,
    );
    stats.publicIndexUpserted += 1;
    return true;
  }

  if (key.startsWith(ACCOUNT_RECORD_PREFIX)) {
    const record = await readObjectJson(
      await env.R2_BUCKET.get(key),
      isAccountRecord,
    );
    if (!record) {
      stats.invalid += 1;
      return true;
    }
    await putAccountRecord(env.R2_BUCKET, record, env.DB);
    stats.accountsUpserted += 1;
    return true;
  }

  if (key.startsWith(BRANCH_KEY_PREFIX)) {
    const branch = await readR2Json(env.R2_BUCKET, key, isDropBranchRecord);
    if (!branch) {
      stats.invalid += 1;
      return true;
    }
    const repository = createBranchRepository({
      blobs: env.R2_BUCKET,
      sql: env.DB,
    });
    await repository.writeBranch(branch);
    stats.branchesUpserted += 1;
    return true;
  }

  if (key.startsWith(WRITER_BRANCH_KEY_PREFIX)) {
    const branchId = await readObjectText(await env.R2_BUCKET.get(key));
    if (!branchId || !(await upsertWriterPointer(env, key, branchId))) {
      stats.invalid += 1;
      return true;
    }
    stats.writerPointersUpserted += 1;
    return true;
  }

  if (key.startsWith(SNAPSHOT_KEY_PREFIX)) {
    const snapshot = await readR2Json(env.R2_BUCKET, key, isDropSnapshotRecord);
    if (!snapshot) {
      stats.invalid += 1;
      return true;
    }
    const repository = createBranchRepository({
      blobs: env.R2_BUCKET,
      sql: env.DB,
    });
    await repository.writeSnapshot(snapshot);
    stats.snapshotsUpserted += 1;
    return true;
  }

  if (key.startsWith(BRANCH_DIFF_EVENT_KEY_PREFIX)) {
    const event = await readR2Json(env.R2_BUCKET, key, isDropDiffEvent);
    if (!event) {
      stats.invalid += 1;
      return true;
    }
    const repository = createBranchDiffRepository({
      blobs: env.R2_BUCKET,
      sql: env.DB,
    });
    await repository.writeBranchDiffEvent(
      event.dropId,
      key.slice(BRANCH_DIFF_EVENT_KEY_PREFIX.length).split("/")[1] ?? "",
      event,
    );
    stats.eventsUpserted += 1;
    return true;
  }

  if (key.startsWith(DIFF_AUTH_KEY_PREFIX)) {
    const credential = await readR2Json(
      env.R2_BUCKET,
      key,
      isDiffAuthCredentialRecord,
    );
    if (!credential) {
      stats.invalid += 1;
      return true;
    }
    const repository = createDiffCredentialRepository({
      blobs: env.R2_BUCKET,
      sql: env.DB,
    });
    await repository.putDiffAuthCredential(credential);
    stats.diffCredentialsUpserted += 1;
    return true;
  }

  if (key.startsWith(NULLPLUG_UI_RESPONSE_FACT_KEY_PREFIX)) {
    const fact = await readObjectJson(
      await env.R2_BUCKET.get(key),
      isNullplugUiResponseFact,
    );
    if (!fact) {
      stats.invalid += 1;
      return true;
    }
    await syncNullplugUiResponseFactToD1(env.DB, fact);
    stats.nullplugFactsUpserted += 1;
    return true;
  }

  if (key.startsWith(NULLPLUG_UI_STATE_PATCH_FACT_KEY_PREFIX)) {
    const fact = await readObjectJson(
      await env.R2_BUCKET.get(key),
      isNullplugUiStatePatchFact,
    );
    if (!fact) {
      stats.invalid += 1;
      return true;
    }
    await syncNullplugUiStateFactToD1(env.DB, fact);
    stats.nullplugFactsUpserted += 1;
    return true;
  }

  if (key.startsWith(NULLPLUG_UI_STATE_SNAPSHOT_KEY_PREFIX)) {
    const fact = await readObjectJson(
      await env.R2_BUCKET.get(key),
      isNullplugUiStateSnapshot,
    );
    if (!fact) {
      stats.invalid += 1;
      return true;
    }
    await syncNullplugUiStateFactToD1(env.DB, fact);
    stats.nullplugFactsUpserted += 1;
    return true;
  }

  if (key.startsWith(DROP_RESOLVED_HEAP_KEY_PREFIX)) {
    const state = await readObjectJson(
      await env.R2_BUCKET.get(key),
      isResolvedNulldownState,
    );
    if (!state) {
      stats.invalid += 1;
      return true;
    }
    await syncResolvedStateToD1(env.DB, state);
    stats.resolvedHeapsUpserted += 1;
    return true;
  }

  return false;
};

/** Projects one listed R2 object into its owning D1 metadata projection. */
export const projectR2MetadataObject = async (
  env: Required<Pick<MetadataBackfillEnv, "R2_BUCKET" | "DB">>,
  key: string,
  stats: MetadataBackfillStats,
): Promise<void> => {
  if (await projectInternalObject(env, key, stats)) return;
  if (key.startsWith("__")) {
    stats.skipped += 1;
    return;
  }
  await projectDropObject(env, key, stats);
};

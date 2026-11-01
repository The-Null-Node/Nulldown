import { BranchStateError } from "../../../../shared/drop/branch-state";
import { decodeDropEnvelope } from "../../../../shared/drop/codecs/envelope-v1";
import type { DropVisibility } from "../../../../shared/drop/types";
import {
  DROP_DIFF_EVENT_METADATA_KEY_PREFIX,
  DROP_SNAPSHOT_METADATA_KEY_PREFIX,
  DROP_RESOLVED_HEAP_KEY_PREFIX,
} from "../../../../shared/drop/sidecar";
import {
  NULLPLUG_UI_RESPONSE_FACT_KEY_PREFIX,
  NULLPLUG_UI_STATE_PATCH_FACT_KEY_PREFIX,
  NULLPLUG_UI_STATE_SNAPSHOT_KEY_PREFIX,
} from "../../../../shared/nullplug/ui";
import type {
  BlobObjectStore,
  SqlMetadataStore,
} from "../../../../src/server/ports";
import { readAccountLibraryEntry } from "../accounts/library/repository";
import { sanitizeAccountId } from "../accounts/identity/records";
import { ApiHttpError } from "../core/http/responses";
import { decryptProviderEscrowEnvelope } from "../crypto/envelopes/provider-escrow";
import { DIFF_AUTH_KEY_PREFIX } from "../diffs/credentials/repository";
import { resolveRuntimeDataScopeKey } from "../core/platform/cloudflare/runtime-data/keys";

/** Request-local verified root identity; it does not contain content or decryption keys. */
export interface VerifiedBootstrapRoot {
  rootDropId: string;
  ownerAccountId: string;
  visibility: DropVisibility;
}

const reject = (status: number, code: string): never => {
  throw new ApiHttpError({
    status,
    code,
    message: "Root cannot initialize the selected branch authority.",
  });
};

/** Reads trusted ownership for local bootstrap; missing projections never inherit legacy public access. */
export async function readVerifiedBootstrapRoot(
  sql: SqlMetadataStore,
  rootDropId: string,
  accountId: string,
): Promise<VerifiedBootstrapRoot> {
  const entry = await readAccountLibraryEntry(sql, rootDropId);
  if (!entry) return reject(503, "account_library_unavailable");
  if (
    entry.drop_id !== rootDropId ||
    !entry.account_id ||
    sanitizeAccountId(entry.account_id) !== entry.account_id ||
    !["private", "public", "unlisted"].includes(entry.visibility)
  )
    return reject(503, "account_library_invalid");
  if (
    entry.deleted_at !== null ||
    (entry.visibility === "private" && entry.account_id !== accountId)
  ) {
    return reject(404, "branch_not_found");
  }
  return {
    rootDropId,
    ownerAccountId: entry.account_id,
    visibility: entry.visibility,
  };
}

// A single raw object is enough to disqualify a root, even if its record is corrupt.
// Include orphan checkpoints, receipts and event markers, not only published heads.
const legacyPrefixes = [
  "__drop_branch__/",
  "__drop_writer_branch__/",
  "__drop_snapshot__/",
  "__drop_checkpoint__/",
  "__drop_branch_diffs__/",
  "__drop_branch_diff_events__/",
  "__drop_branch_diff_event_ids__/",
  "__drop_branch_diff_event_id_markers_v2__/",
  "__drop_branch_runtime_fact_events__/",
  "__drop_branch_runtime_fact_event_ids__/",
  "__drop_branch_runtime_fact_heads__/",
  "__drop_branch_promotion_receipts__/",
  "__drop_publication_receipts__/",
  "__drop_branch_lock__/",
  DROP_DIFF_EVENT_METADATA_KEY_PREFIX,
  DROP_SNAPSHOT_METADATA_KEY_PREFIX,
  DROP_RESOLVED_HEAP_KEY_PREFIX,
  NULLPLUG_UI_RESPONSE_FACT_KEY_PREFIX,
  NULLPLUG_UI_STATE_PATCH_FACT_KEY_PREFIX,
  NULLPLUG_UI_STATE_SNAPSHOT_KEY_PREFIX,
  DIFF_AUTH_KEY_PREFIX,
];

/**
 * Excludes raw legacy history and derived branch state before selecting an immutable
 * local root. Fixed composition excludes concurrent legacy writes; errors and
 * incomplete scans never establish absence. Global payloads/catalogs have no root
 * identity and are not evidence; their root-scoped references are checked here.
 */
export async function assertNoLegacyRootHistory(
  blobs: BlobObjectStore,
  sql: SqlMetadataStore,
  rootDropId: string,
): Promise<void> {
  for (const table of [
    "branches",
    "branch_writers",
    "branch_snapshots",
    "branch_events",
    "branch_runtime_facts",
    "nullplug_facts",
    "nullmem_records",
    "resolved_heaps",
    "resolved_nodes",
    "resolved_heap_deltas",
    "resolved_node_refs",
    "resolved_priority_facts",
  ]) {
    const row = await sql
      .prepare(
        `SELECT 1 AS present FROM ${table} WHERE root_drop_id = ? LIMIT 1`,
      )
      .bind(rootDropId)
      .first();
    if (row !== null) return reject(409, "branch_authority_mismatch");
  }
  const credential = await sql
    .prepare(
      "SELECT 1 AS present FROM diff_auth_credentials WHERE drop_id = ? LIMIT 1",
    )
    .bind(rootDropId)
    .first();
  if (credential !== null) return reject(409, "branch_authority_mismatch");
  // Generic runtime state includes snapshotter checkpoints, sidecars, memory and
  // resolved projections. Inspect both canonical scope keys and record identities;
  // orphan indexes/FTS entries also disqualify a root, independently of record rows.
  const scopeSegment = `/${resolveRuntimeDataScopeKey({ rootDropId })}/`;
  for (const table of [
    "void_data_records",
    "void_data_indexes",
    "void_data_fts",
  ]) {
    const query =
      table === "void_data_records"
        ? `SELECT 1 AS present FROM ${table} WHERE instr('/' || scope_key || '/', ?) > 0 OR json_extract(key_json, '$.scope.rootDropId') = ? LIMIT 1`
        : `SELECT 1 AS present FROM ${table} WHERE instr('/' || scope_key || '/', ?) > 0 LIMIT 1`;
    const statement = sql.prepare(query);
    const row = await (
      table === "void_data_records"
        ? statement.bind(scopeSegment, rootDropId)
        : statement.bind(scopeSegment)
    ).first();
    if (row !== null) return reject(409, "branch_authority_mismatch");
  }
  for (const namespace of legacyPrefixes) {
    const result = await blobs.list({
      prefix: `${namespace}${rootDropId}/`,
      limit: 1,
    });
    if (
      !result ||
      !Array.isArray(result.objects) ||
      typeof result.truncated !== "boolean"
    ) {
      throw new BranchStateError("state_unavailable");
    }
    if (result.objects.length) return reject(409, "branch_authority_mismatch");
    if (result.truncated) throw new BranchStateError("state_unavailable");
  }
}

/** Captures one immutable, identity-checked signed root revision before opening provider escrow. */
export async function readRootInitializationSource(input: {
  blobs: BlobObjectStore;
  providerPrivateKey?: string;
  root: VerifiedBootstrapRoot;
  expectedRevision: string;
}): Promise<{ rootRevision: string; content: string }> {
  const object = await input.blobs.get(input.root.rootDropId);
  if (!object) return reject(404, "drop_not_found");
  const rootRevision = object.etag ?? object.httpEtag;
  if (!rootRevision) return reject(503, "root_revision_unavailable");
  if (rootRevision !== input.expectedRevision)
    return reject(409, "branch_initialization_source_changed");
  let raw: unknown;
  try {
    raw = await object.json();
  } catch (error) {
    if (error instanceof SyntaxError)
      return reject(409, "branch_initialization_root_invalid");
    throw new BranchStateError("state_unavailable");
  }
  const envelope = decodeDropEnvelope(raw);
  if (!envelope) return reject(409, "branch_initialization_root_invalid");
  if (
    envelope.accountId !== input.root.ownerAccountId ||
    envelope.visibility !== input.root.visibility
  ) {
    return reject(409, "branch_initialization_root_identity_mismatch");
  }
  if (envelope.metadata?.ownerPublication !== undefined)
    return reject(409, "branch_authority_mismatch");
  if (envelope.unlockPolicy !== "provider-escrow" || !envelope.providerEscrow)
    return reject(409, "branch_initialization_escrow_required");
  if (!input.providerPrivateKey)
    return reject(503, "branch_initialization_crypto_unavailable");
  try {
    const payload = await decryptProviderEscrowEnvelope(
      envelope,
      input.providerPrivateKey,
    );
    return { rootRevision, content: payload.content };
  } catch {
    return reject(409, "branch_initialization_root_unreadable");
  }
}

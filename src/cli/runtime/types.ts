import type { DropDiffEnvelope } from "../../../shared/drop/diff";
import type {
  CliCredentialBundleV1,
  CliDevicePollResponse,
  CliDeviceStartResponse,
  CliEncryptionPublicJwk,
} from "../../../shared/auth/cliDevice";

/** Result returned by a drop read operation. */
export interface DropReadResult {
  /** Canonical drop id returned by the API. */
  id: string;
  /** Drop id requested by the user. */
  requestedId: string;
  /** Current root revision, when available. */
  revision: string | null;
  /** Response content type. */
  contentType: string;
  /** Parsed response body when JSON was returned. */
  body: unknown;
  /** Raw response text. */
  text: string;
}

/** Request for creating a drop. */
export interface DropCreateRequest {
  /** Plaintext drop content. */
  content: string;
  /** Optional drop metadata. */
  metadata?: Record<string, unknown> | null;
}

/** Result returned after creating a drop. */
export interface DropCreateResult {
  /** Created drop id. */
  id: string;
  /** Canonical URL for the created drop. */
  url: string;
}

/** Request for updating a drop root. */
export interface DropUpdateRequest {
  /** Canonical drop id to update. */
  id: string;
  /** Replacement plaintext content. */
  content: string;
  /** Metadata to store with the root. */
  metadata: Record<string, unknown>;
  /** Optional expected root revision for optimistic concurrency. */
  expectedRevision?: string | null;
}

/** Result returned after updating a drop. */
export interface DropUpdateResult {
  /** Updated drop id. */
  id: string;
  /** Canonical URL for the updated drop. */
  url: string;
}

/** Options for listing drops. */
export interface DropListRequest {
  /** Optional maximum result count. */
  limit?: string | null;
  /** Optional pagination cursor. */
  cursor?: string | null;
}

/** Options for searching drops. */
export interface DropSearchRequest {
  /** Search query text. */
  query?: string | null;
  /** Optional owner filter. */
  owner?: string | null;
  /** Optional visibility filter. */
  visibility?: string | null;
  /** Optional maximum result count. */
  limit?: string | null;
  /** Optional pagination offset. */
  offset?: string | null;
}

/** Options for deleting a drop. */
export interface DropDeleteRequest {
  /** Skip revision precondition checks. */
  force?: boolean;
}

/** Result returned by a drop delete operation. */
export interface DropDeleteResult {
  /** Drop id requested for deletion. */
  deleted: string;
}

/** Runtime facade for drop commands. */
export interface DropRuntime {
  /** Creates a drop using the current runtime backend. */
  create(request: DropCreateRequest): Promise<DropCreateResult>;
  /** Updates a drop root using the current runtime backend. */
  update(request: DropUpdateRequest): Promise<DropUpdateResult>;
  /** Reads a single drop by canonical or short id. */
  get(id: string): Promise<DropReadResult>;
  /** Lists drops using the current runtime backend. */
  list(request?: DropListRequest): Promise<unknown | null>;
  /** Searches drops using the current runtime backend. */
  search(request?: DropSearchRequest): Promise<unknown | null>;
  /** Deletes a drop using the current runtime backend. */
  delete(id: string, request?: DropDeleteRequest): Promise<DropDeleteResult>;
}

/** Runtime facade for read-only branch commands. */
export interface BranchRuntime {
  /** Lists branches for a root drop. */
  list(rootId: string): Promise<unknown | null>;
  /** Resolves the editable branch for a drop. */
  resolve(dropId: string): Promise<unknown | null>;
  /** Reads resolved content for a branch. */
  content(rootId: string, branchId: string): Promise<unknown | null>;
  /** Reads resolved branch content, returning null for a missing branch. */
  contentOrNull(rootId: string, branchId: string): Promise<unknown | null>;
  /** Lists snapshots for a branch. */
  snapshots(rootId: string, branchId: string): Promise<unknown | null>;
  /** Promotes one observed branch snapshot into a retry-safe new drop. */
  promote(input: {
    rootId: string;
    branchId: string;
    expectedSnapshotId: number;
    idempotencyKey: string;
  }): Promise<unknown | null>;
}

/** Request for polling drop diff events. */
export interface DiffPollRequest {
  /** Root drop id to poll. */
  dropId: string;
  /** Optional branch id filter. */
  branchId?: string | null;
  /** Cursor to poll from, or __latest__ for latest state. */
  cursor: string;
  /** Optional maximum event count. */
  limit?: string | null;
  /** Optional client id to exclude from results. */
  excludeClient?: string | null;
}

/** Request for posting a prebuilt diff envelope. */
export interface DiffEnvelopePostRequest {
  /** Root drop id used for routing the request. */
  dropId: string;
  /** Optional branch id query parameter. */
  branchId?: string | null;
  /** Prebuilt diff envelope to post. */
  envelope: DropDiffEnvelope;
}

/** Additional context passed to diff envelope header builders. */
export interface DiffEnvelopeHeadersRequest extends DiffEnvelopePostRequest {
  /** Request path without query string. */
  path: string;
  /** Serialized request body. */
  body: string;
}

/** Runtime facade for drop diff commands. */
export interface DiffRuntime {
  /** Polls diff events for a drop. */
  poll(request: DiffPollRequest): Promise<unknown | null>;
  /** Posts a prebuilt diff envelope. */
  postEnvelope(request: DiffEnvelopePostRequest): Promise<unknown | null>;
}

/** Request for creating an account session. */
export interface AuthSessionRequest {
  /** Account id for the session. */
  accountId: string;
  /** Proof payload supplied by the caller. */
  proof: Record<string, unknown>;
}

/** Request for starting browser-mediated CLI authorization. */
export interface AuthDeviceRequest {
  /** Ephemeral public key that receives the one-time credential envelope. */
  publicKey: CliEncryptionPublicJwk;
  /** Optional human-readable CLI/device name. */
  clientName?: string | null;
}

/** Request for polling a pending CLI authorization. */
export interface AuthDevicePollRequest {
  /** Private device code returned by the start endpoint. */
  deviceCode: string;
}

/** Request for rotating a persisted CLI refresh credential. */
export interface AuthRefreshRequest {
  /** Current refresh credential. */
  refreshToken: string;
}

/** Request for revoking a persisted CLI refresh credential. */
export interface AuthRevokeRequest {
  /** Refresh credential to revoke. */
  refreshToken: string;
}

/** Runtime facade for auth commands. */
export interface AuthRuntime {
  /** Creates an authenticated account session. */
  session(request: AuthSessionRequest): Promise<unknown | null>;
  /** Starts browser-mediated CLI authorization. */
  device(request: AuthDeviceRequest): Promise<CliDeviceStartResponse | null>;
  /** Polls browser-mediated CLI authorization. */
  poll(request: AuthDevicePollRequest): Promise<CliDevicePollResponse | null>;
  /** Rotates a CLI refresh credential. */
  refresh(request: AuthRefreshRequest): Promise<CliCredentialBundleV1 | null>;
  /** Revokes a CLI refresh credential. */
  revoke(request: AuthRevokeRequest): Promise<unknown | null>;
}

/** Supported admin backfill jobs. */
export type AdminBackfillTarget =
  | "branch-backfill"
  | "index-backfill"
  | "metadata-backfill";

/** Request for running a single admin backfill batch. */
export interface AdminBackfillRequest {
  /** Backfill job to run. */
  target: AdminBackfillTarget;
  /** Root drop id for branch backfill jobs. */
  rootId?: string | null;
  /** Admin bearer token. */
  token: string;
  /** Batch size. */
  limit: string;
  /** Optional pagination cursor. */
  cursor?: string | null;
}

/** Runtime facade for admin commands. */
export interface AdminRuntime {
  /** Runs one admin backfill batch. */
  backfill(request: AdminBackfillRequest): Promise<unknown | null>;
}

/** Options for querying a branch resolved heap. */
export interface BranchResolvedQueryRequest {
  /** Root drop id for the branch. */
  rootId: string;
  /** Branch id to query. */
  branchId: string;
  /** Optional semantic query text. */
  query?: string | null;
  /** Optional max result count. */
  top?: string | null;
  /** Optional snapshot id or alias. */
  snapshotId?: string | null;
  /** Optional resolver id. */
  resolverId?: string | null;
  /** Optional comma-separated node kind filter. */
  kind?: string | null;
  /** Optional lower source sequence. */
  fromSeq?: string | null;
  /** Optional upper source sequence. */
  toSeq?: string | null;
  /** Optional runtime plugin id filter. */
  pluginId?: string | null;
  /** Optional runtime call id filter. */
  callId?: string | null;
  /** Optional runtime primitive id filter. */
  primitiveId?: string | null;
  /** Restrict results to changed nodes. */
  changedOnly?: boolean;
  /** Include ancestor context. */
  includeAncestors?: boolean;
  /** Include source event metadata unless explicitly false. */
  includeEventMetadata?: boolean;
}

/** Options for repairing or materializing a branch resolved heap. */
export interface BranchResolvedUpdateRequest {
  /** Root drop id for the branch. */
  rootId: string;
  /** Branch id to update. */
  branchId: string;
  /** Resolver id to update, or all resolvers. */
  resolverId: string;
  /** Optional snapshot id or alias. */
  snapshotId?: string | number | null;
}

/** Runtime facade for resolved branch heap commands. */
export interface ResolvedRuntime {
  /** Queries a branch resolved heap. */
  query(request: BranchResolvedQueryRequest): Promise<unknown | null>;
  /** Repairs or materializes branch resolved heap state. */
  update(request: BranchResolvedUpdateRequest): Promise<unknown | null>;
}

/** Options for querying branch memory records. */
export interface BranchMemoryQueryRequest {
  /** Root drop id for the branch. */
  rootId: string;
  /** Branch id to query. */
  branchId: string;
  /** Optional memory query text. */
  query?: string | null;
  /** Optional memory record kind. */
  kind?: string | null;
  /** Optional label filters. */
  labels?: string[] | null;
  /** Optional max result count. */
  limit?: string | null;
  /** Include freshness metadata in results. */
  includeFreshness?: boolean;
  /** Exact procedure record id for compact next-step projection. */
  procedureId?: string | null;
  /** Return procedure steps with index greater than this cursor. */
  afterStep?: string | null;
  /** Maximum procedure steps to return. */
  stepLimit?: string | null;
  /** Whether full records should be returned alongside capsules. */
  includeRecords?: boolean;
}

/** Request for creating a branch memory fact. */
export interface BranchMemoryFactRequest {
  /** Root drop id for the branch. */
  rootId: string;
  /** Branch id to write. */
  branchId: string;
  /** Fact body text. */
  text: string;
  /** Optional fact title. */
  title?: string | null;
  /** Optional target kind. */
  targetKind?: string | null;
  /** Optional target id. */
  targetId?: string | null;
  /** Optional labels. */
  labels?: string[] | null;
  /** Optional priority score. */
  priority?: number | null;
  /** Optional confidence score. */
  confidence?: number | null;
  /** Optional metadata object. */
  metadata?: Record<string, unknown> | null;
}

/** Request for creating a branch memory procedure. */
export interface BranchMemoryProcedureRequest {
  /** Root drop id for the branch. */
  rootId: string;
  /** Branch id to write. */
  branchId: string;
  /** Procedure goal. */
  goal: string;
  /** Procedure summary. */
  summary: string;
  /** Optional procedure steps. */
  steps?: unknown;
  /** Optional outcome. */
  outcome?: string | null;
  /** Optional reusable-as hint. */
  reusableAs?: string | null;
  /** Optional labels. */
  labels?: string[] | null;
  /** Optional priority score. */
  priority?: number | null;
  /** Optional confidence score. */
  confidence?: number | null;
  /** Optional metadata object. */
  metadata?: Record<string, unknown> | null;
}

/** Request for deleting a branch memory record. */
export interface BranchMemoryDeleteRequest {
  /** Root drop id for the branch. */
  rootId: string;
  /** Branch id to delete from. */
  branchId: string;
  /** Memory record id. */
  recordId: string;
}

/** Runtime facade for branch memory commands. */
export interface MemoryRuntime {
  /** Queries branch memory. */
  query(request: BranchMemoryQueryRequest): Promise<unknown | null>;
  /** Creates a branch memory fact. */
  fact(request: BranchMemoryFactRequest): Promise<unknown | null>;
  /** Creates a branch memory procedure. */
  procedure(request: BranchMemoryProcedureRequest): Promise<unknown | null>;
  /** Deletes a branch memory record. */
  delete(request: BranchMemoryDeleteRequest): Promise<unknown | null>;
}

/** Supported branch priority target kinds. */
export type PriorityTargetKind = "node" | "heap" | "diff";

/** Options for listing branch priority facts. */
export interface BranchPriorityListRequest {
  /** Root drop id for the branch. */
  rootId: string;
  /** Branch id to list from. */
  branchId: string;
  /** Optional resolver id filter. */
  resolverId?: string | null;
  /** Optional target kind filter. */
  targetKind?: string | null;
  /** Optional target id filter. */
  targetId?: string | null;
  /** Optional priority fact id filter. */
  factId?: string | null;
  /** Optional max result count. */
  limit?: string | null;
}

/** Request for creating a branch priority fact. */
export interface BranchPriorityCreateRequest {
  /** Root drop id for the branch. */
  rootId: string;
  /** Branch id to write. */
  branchId: string;
  /** Priority target kind. */
  targetKind: PriorityTargetKind;
  /** Priority score. */
  priority: number;
  /** Optional target id. */
  targetId?: string | null;
  /** Optional resolver id. */
  resolverId?: string | null;
  /** Optional reason. */
  reason?: string | null;
  /** Optional labels. */
  labels?: string[] | null;
  /** Optional metadata object. */
  metadata?: Record<string, unknown> | null;
  /** Optional source sequence. */
  sourceSeq?: number | null;
  /** Optional source event id. */
  sourceEventId?: string | null;
}

/** Request for deleting a branch priority fact. */
export interface BranchPriorityDeleteRequest {
  /** Root drop id for the branch. */
  rootId: string;
  /** Branch id to delete from. */
  branchId: string;
  /** Priority fact id. */
  factId: string;
}

/** Runtime facade for branch priority commands. */
export interface PriorityRuntime {
  /** Lists branch priority facts. */
  list(request: BranchPriorityListRequest): Promise<unknown | null>;
  /** Creates a branch priority fact. */
  create(request: BranchPriorityCreateRequest): Promise<unknown | null>;
  /** Deletes a branch priority fact. */
  delete(request: BranchPriorityDeleteRequest): Promise<unknown | null>;
}

/** Command-facing runtime facade for Nulldown domains. */
export interface NulldownRuntime {
  /** Drop read/list capabilities. */
  drops: DropRuntime;
  /** Read-only branch capabilities. */
  branches: BranchRuntime;
  /** Drop diff capabilities. */
  diffs: DiffRuntime;
  /** Auth capabilities. */
  auth: AuthRuntime;
  /** Admin capabilities. */
  admin: AdminRuntime;
  /** Resolved branch heap capabilities. */
  resolved: ResolvedRuntime;
  /** Branch memory capabilities. */
  memory: MemoryRuntime;
  /** Branch priority capabilities. */
  priority: PriorityRuntime;
}

import {
  isDropBranchRecord,
  type DropBranchRecord,
} from "../../../shared/drop/branch";
import {
  BranchLifecycleQuery,
  sameBranchInitializationIdentity,
  type BranchAuthorityRecord,
  type BranchInitializationIdentity,
  type BranchLifecycleStatePlane,
} from "../../../shared/drop/branch-lifecycle";
import {
  BranchStateError,
  BranchStateQuery,
  type BranchStateHead,
  type BranchStatePlacement,
  type BranchStateTarget,
} from "../../../shared/drop/branch-state";
import { DROP_ID_LENGTH, isDropIdToken } from "../../../shared/drop/id";
import { sanitizeAccountId } from "../../../functions/api/_lib/accounts/identity/records";
import {
  assertNoLegacyRootHistory,
  readRootInitializationSource,
  readVerifiedBootstrapRoot,
} from "../../../functions/api/_lib/branches/local-bootstrap";
import {
  createCloneBranchId,
  createWriterKey,
} from "../../../functions/api/_lib/branches/storage/keys";
import {
  ApiHttpError,
  isApiHttpError,
} from "../../../functions/api/_lib/core/http/responses";
import type { BlobObjectStore, SqlMetadataStore } from "../ports";

/** Durable capabilities consumed by local bootstrap; no runtime-data or legacy authority fallback. */
export type LocalBranchLifecycleBackend = Pick<
  BranchLifecycleStatePlane,
  "readPlacement" | "reserve" | "initialize" | "readHead"
>;

/** Internal lifecycle bound to one explicit local composition; callers supply authenticated account identity. */
export interface LocalBranchLifecycle {
  resolveForActor(
    rootDropId: string,
    accountId: string | null,
    clientId: string | null,
  ): Promise<{ branch: DropBranchRecord; created: boolean }>;
  /** Control-plane read only. A pending reservation never grants document access. */
  readPlacement(
    target: BranchStateTarget,
  ): Promise<BranchAuthorityRecord | null>;
  /** Obtains active durable fencing for an already authorized application operation. */
  requireActivePlacement(
    target: BranchStateTarget,
  ): Promise<BranchStatePlacement>;
}

/** Explicit local composition dependencies, with verified root projections and immutable-source admission. */
export interface LocalBranchLifecycleOptions {
  mode: "local-test";
  blobs: BlobObjectStore;
  sql: SqlMetadataStore;
  providerPrivateKey?: string;
  backend: LocalBranchLifecycleBackend;
  isEligibleRoot(rootDropId: string): boolean;
  initialPlacement: BranchStatePlacement;
}

const fail = (status: number, code: string): never => {
  throw new ApiHttpError({
    status,
    code,
    message: "The selected local branch lifecycle rejected this operation.",
  });
};
const branchIdFor = (owner: string, writer: string): string =>
  owner === writer
    ? "owner"
    : createCloneBranchId(createWriterKey(writer, null));

/**
 * Creates local-only bootstrap for immutable signed roots. Fixed eligible composition
 * must exclude concurrent legacy writers and reject root replacement, deletion,
 * publication and promotion. Durable reservation/activation coordinates concurrent
 * callers and crash recovery; this adapter never acquires an R2 lease.
 */
export function createLocalBranchLifecycle(
  input: LocalBranchLifecycleOptions,
): LocalBranchLifecycle {
  if (input.mode !== "local-test")
    throw new BranchStateError("capability_unsupported");
  const options = { ...input, initialPlacement: { ...input.initialPlacement } };
  const { backend, blobs, sql } = options;
  const captureTarget = (target: BranchStateTarget): BranchStateTarget => {
    const captured = BranchLifecycleQuery.placement({ target }).target;
    if (
      !isDropIdToken(captured.rootDropId) ||
      captured.rootDropId.length < DROP_ID_LENGTH
    )
      throw new BranchStateError("invalid_command");
    if (!options.isEligibleRoot(captured.rootDropId))
      return fail(409, "branch_authority_mismatch");
    return captured;
  };
  const available = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof BranchStateError || isApiHttpError(error))
        throw error;
      throw new BranchStateError("state_unavailable");
    }
  };
  const validateAuthority = (
    target: BranchStateTarget,
    value: BranchAuthorityRecord,
  ): BranchAuthorityRecord => {
    try {
      const record = BranchLifecycleQuery.authority(value);
      const identity = record.reservation.identity;
      if (
        record.target.rootDropId !== target.rootDropId ||
        record.target.branchId !== target.branchId ||
        !identity.ownerAccountId ||
        sanitizeAccountId(identity.ownerAccountId) !==
          identity.ownerAccountId ||
        !identity.writerAccountId ||
        sanitizeAccountId(identity.writerAccountId) !==
          identity.writerAccountId ||
        identity.baseDropId !== target.rootDropId ||
        target.branchId !==
          branchIdFor(identity.ownerAccountId, identity.writerAccountId) ||
        identity.mode !== (target.branchId === "owner" ? "owner" : "clone")
      )
        throw new Error("invalid authority");
      return record;
    } catch {
      throw new BranchStateError("state_corrupt");
    }
  };
  const readPlacement = (target: BranchStateTarget) =>
    available(async () => {
      const captured = captureTarget(target);
      const authority = await backend.readPlacement({ target: captured });
      return authority === null ? null : validateAuthority(captured, authority);
    });
  const currentHead = async (
    authority: BranchAuthorityRecord,
  ): Promise<BranchStateHead> => {
    const result = await backend.readHead(
      BranchStateQuery.head({
        target: authority.target,
        placement: authority.placement,
      }),
    );
    try {
      const head = structuredClone(result);
      if (!head || Array.isArray(head) || !isDropBranchRecord(head.branch))
        throw new Error("invalid head");
      const { version } = BranchStateQuery.content({
        target: head.target,
        placement: head.placement,
        version: head.version,
      });
      if (
        head.branch.status !== "active" ||
        head.branch.snapshotHeapVersion !== 2 ||
        head.branch.checkpointInterval !== 24 ||
        !Number.isSafeInteger(head.branch.createdAt) ||
        head.branch.createdAt < 0 ||
        !Number.isSafeInteger(head.branch.updatedAt) ||
        head.branch.updatedAt < 0 ||
        (version.snapshotId === 0 &&
          head.branch.updatedAt !== head.branch.createdAt) ||
        !Number.isSafeInteger(version.snapshotId) ||
        !Number.isSafeInteger(version.eventSeq) ||
        (version.snapshotId === 0) !== (version.eventSeq === -1) ||
        version.eventSeq < version.snapshotId - 1 ||
        head.target.rootDropId !== authority.target.rootDropId ||
        head.target.branchId !== authority.target.branchId ||
        head.placement.routingVersion !== authority.placement.routingVersion ||
        head.placement.generation !== authority.placement.generation ||
        head.branch.rootDropId !== authority.target.rootDropId ||
        head.branch.branchId !== authority.target.branchId ||
        !sameBranchInitializationIdentity(
          head.branch,
          authority.reservation.identity,
        ) ||
        head.branch.writerClientId !==
          authority.reservation.identity.writerClientId ||
        head.branch.createdAt !== authority.reservation.createdAt ||
        head.branch.headSnapshotId !== head.version.snapshotId ||
        head.branch.headEventSeq !== head.version.eventSeq
      )
        throw new Error("incoherent head");
      return head;
    } catch {
      throw new BranchStateError("state_corrupt");
    }
  };
  return {
    readPlacement,
    requireActivePlacement: (target) =>
      available(async () => {
        const authority = await readPlacement(target);
        if (!authority) throw new BranchStateError("branch_not_found");
        if (authority.state !== "active")
          throw new BranchStateError("branch_initialization_pending");
        return { ...authority.placement };
      }),
    resolveForActor: (rootDropId, accountId, clientId) =>
      available(async () => {
        const root = captureTarget({
          rootDropId,
          branchId: "owner",
        }).rootDropId;
        if (!accountId || sanitizeAccountId(accountId) !== accountId)
          return fail(401, "account_required");
        // This gate also covers implicit diff resolution, whose transport does not check root readability.
        const verified = await readVerifiedBootstrapRoot(sql, root, accountId);
        const target = captureTarget({
          rootDropId: root,
          branchId: branchIdFor(verified.ownerAccountId, accountId),
        });
        const identity: BranchInitializationIdentity = {
          baseDropId: root,
          mode: target.branchId === "owner" ? "owner" : "clone",
          ownerAccountId: verified.ownerAccountId,
          writerAccountId: accountId,
          writerClientId: clientId,
        };
        const recheckAuthorization = async () => {
          const current = await readVerifiedBootstrapRoot(sql, root, accountId);
          if (
            current.ownerAccountId !== verified.ownerAccountId ||
            current.visibility !== verified.visibility
          )
            return fail(409, "branch_initialization_root_identity_mismatch");
        };
        let authority = await readPlacement(target);
        if (!authority) {
          await assertNoLegacyRootHistory(blobs, sql, root);
          const object = await blobs.head(root);
          if (!object) return fail(404, "drop_not_found");
          const rootRevision = object.etag ?? object.httpEtag;
          if (!rootRevision) return fail(503, "root_revision_unavailable");
          const command = BranchLifecycleQuery.reserve({
            target,
            placement: options.initialPlacement,
            reservationId: crypto.randomUUID(),
            identity,
            rootRevision,
          });
          await recheckAuthorization();
          const reserved = await backend.reserve(command);
          if (!["reserved", "existing"].includes(reserved.status))
            throw new BranchStateError("state_corrupt");
          authority = validateAuthority(target, reserved.authority);
        }
        if (
          !sameBranchInitializationIdentity(
            authority.reservation.identity,
            identity,
          )
        )
          throw new BranchStateError("branch_initialization_conflict");
        if (authority.state === "active")
          return {
            branch: (await currentHead(authority)).branch,
            created: false,
          };
        const source = await readRootInitializationSource({
          blobs,
          providerPrivateKey: options.providerPrivateKey,
          root: verified,
          expectedRevision: authority.reservation.rootRevision,
        });
        await recheckAuthorization();
        const initialized = await backend.initialize({
          target,
          placement: authority.placement,
          reservationId: authority.reservation.reservationId,
          ...source,
        });
        if (
          !["created", "duplicate"].includes(initialized.status) ||
          initialized.receipt.reservationId !==
            authority.reservation.reservationId ||
          initialized.receipt.rootRevision !==
            authority.reservation.rootRevision ||
          initialized.receipt.target.rootDropId !== target.rootDropId ||
          initialized.receipt.target.branchId !== target.branchId ||
          initialized.receipt.placement.routingVersion !==
            authority.placement.routingVersion ||
          initialized.receipt.placement.generation !==
            authority.placement.generation
        )
          throw new BranchStateError("state_corrupt");
        return {
          branch: (await currentHead(authority)).branch,
          created: initialized.status === "created",
        };
      }),
  };
}

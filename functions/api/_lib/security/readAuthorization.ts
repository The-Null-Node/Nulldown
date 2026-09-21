import type { DropBranchRecord } from "../../../../shared/drop/branch";
import type { SqlMetadataStore } from "../../../../src/server/ports";
import { readAccountLibraryEntry } from "../accounts/library/repository";
import {
  resolveAuthenticatedAccountId,
  type AccountAuthEnv,
  type AccountAuthRequest,
} from "../accounts/session/authentication";

/** Neutral ports required to authorize identifier-based root reads. */
export interface RootReadAuthorizationPorts extends AccountAuthEnv {
  DB?: SqlMetadataStore;
}

/** Authorizes a sensitive branch read from trusted projection and exact-writer state. */
export const canReadSensitiveBranch = async (
  request: AccountAuthRequest,
  ports: RootReadAuthorizationPorts,
  rootDropId: string,
  branch: { writerAccountId?: DropBranchRecord["writerAccountId"] },
): Promise<boolean> => {
  const accountId = await resolveAuthenticatedAccountId(request, ports);
  if (!accountId) return false;

  const entry = ports.DB
    ? await readAccountLibraryEntry(ports.DB, rootDropId)
    : null;
  if (!entry) return branch.writerAccountId === accountId;

  if (
    entry.deleted_at !== null ||
    (entry.visibility !== "public" &&
      entry.visibility !== "unlisted" &&
      entry.visibility !== "private")
  ) {
    return false;
  }

  return entry.account_id === accountId || branch.writerAccountId === accountId;
};

/** Typed root-read decision derived only from trusted projection and session state. */
export type RootReadAuthorizationDecision =
  | { kind: "identifier-readable" }
  | { kind: "private"; accountId: string; isCanonicalOwner: boolean }
  | { kind: "denied" };

/** Returns whether a root decision permits identifier access or canonical-owner access. */
export const canReadRoot = (decision: RootReadAuthorizationDecision): boolean =>
  decision.kind === "identifier-readable" ||
  (decision.kind === "private" && decision.isCanonicalOwner);

/** Resolves root visibility and private ownership without inspecting stored drop metadata. */
export const resolveRootReadAuthorization = async (
  request: AccountAuthRequest,
  ports: RootReadAuthorizationPorts,
  rootDropId: string,
): Promise<RootReadAuthorizationDecision> => {
  const entry = ports.DB
    ? await readAccountLibraryEntry(ports.DB, rootDropId)
    : null;

  // Projection absence intentionally retains identifier-readable legacy behavior until S2/S3.
  if (!entry) {
    return { kind: "identifier-readable" };
  }

  if (entry.deleted_at !== null) {
    return { kind: "denied" };
  }

  if (entry.visibility === "public" || entry.visibility === "unlisted") {
    return { kind: "identifier-readable" };
  }

  if (entry.visibility !== "private") {
    return { kind: "denied" };
  }

  const accountId = await resolveAuthenticatedAccountId(request, ports);
  if (!accountId) {
    return { kind: "denied" };
  }

  return {
    kind: "private",
    accountId,
    isCanonicalOwner: accountId === entry.account_id,
  };
};

/** Returns whether a resolved branch may be read under a trusted root decision. */
export const canReadBranch = (
  decision: RootReadAuthorizationDecision,
  branch: Pick<DropBranchRecord, "writerAccountId">,
): boolean =>
  decision.kind === "identifier-readable" ||
  (decision.kind === "private" &&
    (decision.isCanonicalOwner ||
      branch.writerAccountId === decision.accountId));

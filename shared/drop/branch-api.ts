import {
  type DropBranchListResponse,
  type DropBranchContentResponse,
  type DropBranchPromoteResponse,
  type DropBranchPromoteRequest,
  type DropBranchResolveResponse,
  type DropSnapshotListResponse,
} from "./branch";
import type {
  ResolvedDocumentNodeQueryResult,
  ResolvedRuntimeNodeQueryResult,
} from "./resolved/types";
import type {
  NullplugUiPrimitive,
  NullplugUiResponseFact,
  NullplugUiStatePatchFact,
  NullplugUiStateSnapshot,
} from "../nullplug/ui";
import {
  isNullplugUiResponseFact,
  isNullplugUiStatePatchFact,
  isNullplugUiStateSnapshot,
} from "../nullplug/ui";
import { isNulldownSourceHash } from "./resolved/hash";
import {
  isResolvedDocumentNodeQueryResult,
  isResolvedRuntimeNodeQueryResult,
} from "./resolved/validators";

export interface BranchResolvedQueryOptions {
  resolverId?: string;
  query?: string;
  top?: number;
  kind?: string;
  snapshotId?: number | "latest";
  fromSeq?: number;
  toSeq?: number;
  changedOnly?: boolean;
  includeAncestors?: boolean;
  includeEventMetadata?: boolean;
  pluginId?: string;
  callId?: string;
  primitiveId?: string;
}

export interface BranchResolvedQueryResponse {
  rootDropId: string;
  branchId: string;
  snapshotId: number;
  resolverId: string;
  resolverVersion: string;
  sourceContentHash: string;
  stale: boolean;
  heapGenerated: boolean;
  nodeCount: number;
  nodes: Array<
    ResolvedDocumentNodeQueryResult | ResolvedRuntimeNodeQueryResult
  >;
}

export interface BranchResolvedUpdateRequest {
  resolverId?: string;
  snapshotId?: number | "latest";
  uiPrimitives?: NullplugUiPrimitive[];
  uiResponseFacts?: NullplugUiResponseFact[];
  uiStatePatchFacts?: NullplugUiStatePatchFact[];
  uiStateSnapshots?: NullplugUiStateSnapshot[];
}

export interface BranchResolvedUpdateResponse {
  rootDropId: string;
  branchId: string;
  snapshotId: number;
  sourceContentHash: string;
  updated: Array<{
    resolverId: string;
    key: string;
    nodeCount: number;
    sourceContentHash: string;
  }>;
}

export interface NullplugResponseSubmitResponse {
  stored: boolean;
  indexed: boolean;
  key: string;
  fact: NullplugUiResponseFact;
}

export interface NullplugStateSubmitResponse {
  stored: boolean;
  indexed: boolean;
  key: string;
  fact: NullplugUiStatePatchFact | NullplugUiStateSnapshot;
}

/** Application-facing branch HTTP operations implemented by a runtime adapter. */
export interface BranchApiClient {
  listBranches(rootDropId: string): Promise<DropBranchListResponse>;
  resolveBranch(dropId: string): Promise<DropBranchResolveResponse>;
  getBranchContent(
    rootDropId: string,
    branchId: string,
  ): Promise<DropBranchContentResponse>;
  listSnapshots(
    rootDropId: string,
    branchId: string,
  ): Promise<DropSnapshotListResponse>;
  queryResolved(
    rootDropId: string,
    branchId: string,
    options?: BranchResolvedQueryOptions,
  ): Promise<BranchResolvedQueryResponse>;
  updateResolved(
    rootDropId: string,
    branchId: string,
    update?: BranchResolvedUpdateRequest,
  ): Promise<BranchResolvedUpdateResponse>;
  submitNullplugResponse(
    fact: NullplugUiResponseFact,
  ): Promise<NullplugResponseSubmitResponse>;
  submitNullplugState(
    fact: NullplugUiStatePatchFact | NullplugUiStateSnapshot,
  ): Promise<NullplugStateSubmitResponse>;
  promoteBranch(
    rootDropId: string,
    branchId: string,
    promotion: DropBranchPromoteRequest,
  ): Promise<DropBranchPromoteResponse>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === "string";

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** Returns true when a value is a valid resolved-heap query response. */
export const isBranchResolvedQueryResponse = (
  value: unknown,
): value is BranchResolvedQueryResponse =>
  isRecord(value) &&
  isString(value.rootDropId) &&
  isString(value.branchId) &&
  isNumber(value.snapshotId) &&
  isString(value.resolverId) &&
  isString(value.resolverVersion) &&
  isNulldownSourceHash(value.sourceContentHash) &&
  typeof value.stale === "boolean" &&
  typeof value.heapGenerated === "boolean" &&
  isNumber(value.nodeCount) &&
  Array.isArray(value.nodes) &&
  value.nodes.every(
    (node) =>
      isResolvedDocumentNodeQueryResult(node) ||
      isResolvedRuntimeNodeQueryResult(node),
  );

/** Returns true when a value is a valid resolved-heap update receipt. */
export const isBranchResolvedUpdateResponse = (
  value: unknown,
): value is BranchResolvedUpdateResponse =>
  isRecord(value) &&
  isString(value.rootDropId) &&
  isString(value.branchId) &&
  isNumber(value.snapshotId) &&
  isNulldownSourceHash(value.sourceContentHash) &&
  Array.isArray(value.updated) &&
  value.updated.every(
    (entry) =>
      isRecord(entry) &&
      isString(entry.resolverId) &&
      isString(entry.key) &&
      isNumber(entry.nodeCount) &&
      isNulldownSourceHash(entry.sourceContentHash),
  );

/** Returns true when a value acknowledges one persisted Nullplug response fact. */
export const isNullplugResponseSubmitResponse = (
  value: unknown,
): value is NullplugResponseSubmitResponse =>
  isRecord(value) &&
  typeof value.stored === "boolean" &&
  typeof value.indexed === "boolean" &&
  isString(value.key) &&
  isNullplugUiResponseFact(value.fact);

/** Returns true when a value acknowledges one persisted Nullplug state fact. */
export const isNullplugStateSubmitResponse = (
  value: unknown,
): value is NullplugStateSubmitResponse =>
  isRecord(value) &&
  typeof value.stored === "boolean" &&
  typeof value.indexed === "boolean" &&
  isString(value.key) &&
  (isNullplugUiStatePatchFact(value.fact) ||
    isNullplugUiStateSnapshot(value.fact));

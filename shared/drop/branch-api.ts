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

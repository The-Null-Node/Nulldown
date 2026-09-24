import type { DropDiffAppendResponse, DropDiffEventAcknowledgement } from "../../../shared/drop/diff";
import type {
  NulldownBranchQueryRequest,
  NulldownDiffApplyRequest,
} from "../../client/nulldownClient";

export interface MemoryAgentBenchClient {
  createDrop(request: { content: string }): Promise<unknown>;
  resolveBranch(dropId: string): Promise<unknown>;
  applyDiff(request: NulldownDiffApplyRequest): Promise<DropDiffAppendResponse>;
  getBranchContent(rootId: string, branchId: string): Promise<unknown>;
  queryBranch(request: NulldownBranchQueryRequest): Promise<unknown>;
}

export interface MemoryAgentBenchRunOptions {
  client: MemoryAgentBenchClient;
  now?: () => number;
  eventId?: (index: number) => string;
}

export interface MemoryAgentBenchIngestReceipt {
  index: number;
  eventId: string;
  createdAt: number;
  followsSeq: number;
  branchId: string;
  snapshotId: number;
  sequence: number;
  status: DropDiffEventAcknowledgement["status"];
  offset: number;
}

export interface MemoryAgentBenchConstructionTiming {
  startedAtMs: number;
  finalizedAtMs: number;
  elapsedMs: number;
}

export interface MemoryAgentBenchRetrievalTiming {
  startedAtMs: number;
  finishedAtMs: number;
  elapsedMs: number;
}

export interface MemoryAgentBenchFinalizeResult {
  rootDropId: string;
  branchId: string;
  snapshotId: number;
  finalEventSequence: number;
  chunkCount: number;
  constructionTiming: MemoryAgentBenchConstructionTiming;
}

export interface MemoryAgentBenchQueryResult {
  rootDropId: string;
  branchId: string;
  snapshotId: number;
  query: string;
  topK: number;
  chunks: string[];
  retrievalTiming: MemoryAgentBenchRetrievalTiming;
  constructionTiming: MemoryAgentBenchConstructionTiming;
}

export interface MemoryAgentBenchTrace {
  rootDropId: string;
  branchId: string;
  nextIndex: number;
  offset: number;
  finalEventSequence: number;
  snapshotId: number;
  finalized: boolean;
  receipts: readonly MemoryAgentBenchIngestReceipt[];
  constructionTiming: MemoryAgentBenchConstructionTiming | null;
}

export interface MemoryAgentBenchRun {
  readonly rootDropId: string;
  readonly branchId: string;
  ingest(index: number, chunk: string): Promise<MemoryAgentBenchIngestReceipt>;
  finalize(): Promise<MemoryAgentBenchFinalizeResult>;
  retrieve(query: string, topK: number): Promise<MemoryAgentBenchQueryResult>;
  trace(): MemoryAgentBenchTrace;
}

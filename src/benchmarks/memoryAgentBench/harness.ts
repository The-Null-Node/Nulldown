import { randomUUID } from "node:crypto";
import type { DropDiffAppendResponse } from "../../../shared/drop/diff";
import { RESOLVED_DOCUMENT_RESOLVER_ID } from "../../../shared/drop/resolved/constants";
import {
  decodeMemoryAgentBenchChunk,
  frameMemoryAgentBenchChunk,
} from "./framing";
import type {
  MemoryAgentBenchConstructionTiming,
  MemoryAgentBenchFinalizeResult,
  MemoryAgentBenchIngestReceipt,
  MemoryAgentBenchQueryResult,
  MemoryAgentBenchRun,
  MemoryAgentBenchRunOptions,
  MemoryAgentBenchTrace,
} from "./types";

const ROOT_SOURCE = "# Memory Agent Bench\n\n";

interface PendingIngest {
  index: number;
  chunk: string;
  eventId: string;
  createdAt: number;
  followsSeq: number;
  sourceText: string;
  offset: number;
}

interface BranchResolution {
  rootDropId: string;
  branchId: string;
  headSnapshotId: number;
}

interface BranchContent {
  rootDropId: string;
  branchId: string;
  snapshotId: number;
  headEventSeq: number | null;
  content: string;
}

interface ResolvedNode {
  kind: string;
  text: string;
}

interface ResolvedResponse {
  rootDropId: string;
  branchId: string;
  snapshotId: number;
  nodes: Array<{ node: ResolvedNode }>;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;

const parseRootId = (value: unknown): string => {
  const id = asRecord(value)?.id;
  if (typeof id !== "string" || !id) {
    throw new Error("Root creation did not return a valid id.");
  }
  return id;
};

const parseBranchResolution = (
  value: unknown,
  expectedRootDropId: string,
): BranchResolution => {
  const input = asRecord(value);
  if (
    !input ||
    input.rootDropId !== expectedRootDropId ||
    typeof input.branchId !== "string" ||
    !input.branchId ||
    !Number.isInteger(input.headSnapshotId) ||
    Number(input.headSnapshotId) < 0
  ) {
    throw new Error("Branch resolution identity is invalid.");
  }
  return {
    rootDropId: input.rootDropId,
    branchId: input.branchId,
    headSnapshotId: Number(input.headSnapshotId),
  };
};

const parseBranchContent = (value: unknown): BranchContent => {
  const input = asRecord(value);
  if (
    !input ||
    typeof input.rootDropId !== "string" ||
    typeof input.branchId !== "string" ||
    !Number.isInteger(input.snapshotId) ||
    (input.headEventSeq !== null && !Number.isInteger(input.headEventSeq)) ||
    typeof input.content !== "string"
  ) {
    throw new Error("Final branch content response is invalid.");
  }
  return input as unknown as BranchContent;
};

const parseResolvedResponse = (value: unknown): ResolvedResponse => {
  const input = asRecord(value);
  if (
    !input ||
    typeof input.rootDropId !== "string" ||
    typeof input.branchId !== "string" ||
    !Number.isInteger(input.snapshotId) ||
    !Array.isArray(input.nodes)
  ) {
    throw new Error("Resolved-document response is invalid.");
  }
  const nodes = input.nodes.map((entry) => {
    const node = asRecord(asRecord(entry)?.node);
    if (!node || typeof node.kind !== "string" || typeof node.text !== "string") {
      throw new Error("Resolved-document node is invalid.");
    }
    return { node: { kind: node.kind, text: node.text } };
  });
  return {
    rootDropId: input.rootDropId,
    branchId: input.branchId,
    snapshotId: Number(input.snapshotId),
    nodes,
  };
};

const validateReceipt = (
  response: DropDiffAppendResponse,
  pending: PendingIngest,
  branchId: string,
  previousSnapshotId: number,
): MemoryAgentBenchIngestReceipt => {
  const acknowledgement = response.acknowledgements?.[0];
  const accepted = acknowledgement?.status === "accepted";
  const duplicate = acknowledgement?.status === "duplicate";
  if (
    response.branchId !== branchId ||
    response.acknowledgements.length !== 1 ||
    acknowledgement.eventId !== pending.eventId ||
    acknowledgement.seq !== pending.index ||
    acknowledgement.snapshotId !== response.snapshotId ||
    response.totalStored !== pending.index + 1 ||
    response.snapshotId <= previousSnapshotId ||
    (accepted && (response.accepted !== 1 || response.deduplicated !== 0)) ||
    (duplicate && (response.accepted !== 0 || response.deduplicated !== 1)) ||
    (!accepted && !duplicate)
  ) {
    throw new Error("Diff acknowledgement identity is invalid.");
  }

  return {
    index: pending.index,
    eventId: pending.eventId,
    createdAt: pending.createdAt,
    followsSeq: pending.followsSeq,
    branchId,
    snapshotId: acknowledgement.snapshotId,
    sequence: acknowledgement.seq,
    status: acknowledgement.status,
    offset: pending.offset + pending.sourceText.length,
  };
};

const assertResolvedIdentity = (
  response: ResolvedResponse,
  rootDropId: string,
  branchId: string,
  snapshotId: number,
): void => {
  if (
    response.rootDropId !== rootDropId ||
    response.branchId !== branchId ||
    response.snapshotId !== snapshotId
  ) {
    throw new Error("Resolved-document snapshot identity is invalid.");
  }
};

export const createMemoryAgentBenchRun = async (
  options: MemoryAgentBenchRunOptions,
): Promise<MemoryAgentBenchRun> => {
  const now = options.now ?? (() => performance.now());
  const createEventId = options.eventId ?? ((index) => `mab-${index}-${randomUUID()}`);
  const constructionStartedAt = now();
  const rootDropId = parseRootId(
    await options.client.createDrop({ content: ROOT_SOURCE }),
  );
  const resolution = parseBranchResolution(
    await options.client.resolveBranch(rootDropId),
    rootDropId,
  );

  let expectedContent = ROOT_SOURCE;
  let offset = ROOT_SOURCE.length;
  let nextIndex = 0;
  let snapshotId = resolution.headSnapshotId;
  let pending: PendingIngest | null = null;
  let constructionTiming: MemoryAgentBenchConstructionTiming | null = null;
  const receipts: MemoryAgentBenchIngestReceipt[] = [];

  const ingest = async (
    index: number,
    chunk: string,
  ): Promise<MemoryAgentBenchIngestReceipt> => {
    if (constructionTiming) {
      throw new Error("Cannot ingest after finalization.");
    }
    if (!Number.isInteger(index) || index !== nextIndex) {
      throw new RangeError(`Expected chunk index ${nextIndex}; received ${index}.`);
    }

    // A lost response may hide an accepted write; retries must retain its exact identity.
    if (pending) {
      if (pending.chunk !== chunk) {
        throw new Error("A retry must use the exact same chunk body.");
      }
    } else {
      const frame = frameMemoryAgentBenchChunk(chunk);
      pending = {
        index,
        chunk,
        eventId: createEventId(index),
        createdAt: Date.now(),
        followsSeq: index - 1,
        sourceText: frame.sourceText,
        offset,
      };
    }

    const attempt = pending;
    const response = await options.client.applyDiff({
      dropId: rootDropId,
      branchId: resolution.branchId,
      eventId: attempt.eventId,
      createdAt: attempt.createdAt,
      ops: [
        {
          type: "insert",
          start: attempt.offset,
          end: attempt.offset,
          text: attempt.sourceText,
        },
      ],
      metadata: {
        kind: "agent.edit",
        intent: "Append one raw MemoryAgentBench chunk.",
        followsSeq: attempt.followsSeq,
      },
    });
    const receipt = validateReceipt(
      response,
      attempt,
      resolution.branchId,
      snapshotId,
    );

    expectedContent += attempt.sourceText;
    offset = receipt.offset;
    nextIndex += 1;
    snapshotId = receipt.snapshotId;
    receipts.push(receipt);
    pending = null;
    return receipt;
  };

  const finalize = async (): Promise<MemoryAgentBenchFinalizeResult> => {
    if (constructionTiming) {
      throw new Error("Run is already finalized.");
    }
    if (pending) {
      throw new Error("Cannot finalize while an ingest outcome is unconfirmed.");
    }
    const finalEventSequence = nextIndex - 1;
    const content = parseBranchContent(
      await options.client.getBranchContent(rootDropId, resolution.branchId),
    );
    if (
      content.rootDropId !== rootDropId ||
      content.branchId !== resolution.branchId ||
      content.snapshotId !== snapshotId ||
      content.headEventSeq !== finalEventSequence ||
      content.content !== expectedContent
    ) {
      throw new Error("Final branch identity or content is invalid.");
    }

    // Charge initial projection materialization to construction, before retrieval timing.
    const projection = parseResolvedResponse(
      await options.client.queryBranch({
        rootId: rootDropId,
        branchId: resolution.branchId,
        snapshotId,
        resolverId: RESOLVED_DOCUMENT_RESOLVER_ID,
        kind: "paragraph",
        top: 1,
      }),
    );
    assertResolvedIdentity(projection, rootDropId, resolution.branchId, snapshotId);

    const finalizedAtMs = now();
    constructionTiming = {
      startedAtMs: constructionStartedAt,
      finalizedAtMs,
      elapsedMs: finalizedAtMs - constructionStartedAt,
    };
    return {
      rootDropId,
      branchId: resolution.branchId,
      snapshotId,
      finalEventSequence,
      chunkCount: nextIndex,
      constructionTiming,
    };
  };

  const retrieve = async (
    query: string,
    topK: number,
  ): Promise<MemoryAgentBenchQueryResult> => {
    if (!constructionTiming) {
      throw new Error("Finalize the run before retrieval.");
    }
    if (!Number.isInteger(topK) || topK < 1 || topK > 100) {
      throw new RangeError("topK must be an integer from 1 through 100.");
    }

    const startedAtMs = now();
    const response = parseResolvedResponse(
      await options.client.queryBranch({
        rootId: rootDropId,
        branchId: resolution.branchId,
        snapshotId,
        resolverId: RESOLVED_DOCUMENT_RESOLVER_ID,
        query,
        kind: "paragraph",
        top: topK,
      }),
    );
    const finishedAtMs = now();
    assertResolvedIdentity(response, rootDropId, resolution.branchId, snapshotId);
    const chunks = response.nodes.map(({ node }) => {
      if (node.kind !== "paragraph") {
        throw new Error("Resolved-document query returned a non-paragraph node.");
      }
      return decodeMemoryAgentBenchChunk(node.text);
    });

    return {
      rootDropId,
      branchId: resolution.branchId,
      snapshotId,
      query,
      topK,
      chunks,
      retrievalTiming: {
        startedAtMs,
        finishedAtMs,
        elapsedMs: finishedAtMs - startedAtMs,
      },
      constructionTiming,
    };
  };

  const trace = (): MemoryAgentBenchTrace => ({
    rootDropId,
    branchId: resolution.branchId,
    nextIndex,
    offset,
    finalEventSequence: nextIndex - 1,
    snapshotId,
    finalized: constructionTiming !== null,
    receipts: [...receipts],
    constructionTiming,
  });

  return {
    rootDropId,
    branchId: resolution.branchId,
    ingest,
    finalize,
    retrieve,
    trace,
  };
};

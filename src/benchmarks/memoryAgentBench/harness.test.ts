import { jest } from "@jest/globals";
import { heapifyResolvedDocument } from "../../../shared/drop/resolved/heapify/document";
import type { DropDiffAppendResponse } from "../../../shared/drop/diff";
import {
  decodeMemoryAgentBenchChunk,
  frameMemoryAgentBenchChunk,
} from "./framing";
import { createMemoryAgentBenchRun } from "./harness";
import type { MemoryAgentBenchClient } from "./types";

const rootDropId = "bench-root";
const branchId = "bench-branch";

const receipt = (
  eventId: string,
  index: number,
  snapshotId: number,
  status: "accepted" | "duplicate" = "accepted",
): DropDiffAppendResponse => ({
  accepted: status === "accepted" ? 1 : 0,
  deduplicated: status === "duplicate" ? 1 : 0,
  branchId,
  snapshotId,
  totalStored: index + 1,
  acknowledgements: [{ eventId, seq: index, snapshotId, status }],
});

const resolved = (snapshotId: number, texts: string[] = []) => ({
  rootDropId,
  branchId,
  snapshotId,
  nodes: texts.map((text) => ({ node: { kind: "paragraph", text } })),
});

const createClient = (): jest.Mocked<MemoryAgentBenchClient> => ({
  createDrop: jest.fn(async () => ({ id: rootDropId })),
  resolveBranch: jest.fn(async () => ({ rootDropId, branchId, headSnapshotId: 0 })),
  applyDiff: jest.fn(async (request) => receipt(request.eventId!, 0, 1)),
  getBranchContent: jest.fn(async () => ({
    rootDropId,
    branchId,
    snapshotId: 0,
    headEventSeq: -1,
    content: "# Memory Agent Bench\n\n",
  })),
  queryBranch: jest.fn(async () => resolved(0)),
});

describe("MemoryAgentBench chunk framing", () => {
  it("frames arbitrary Markdown as one reversible source node", async () => {
    const chunk = [
      "# heading",
      "- [ ] task",
      "```ts",
      "const token = '[link](https://nulldown.test)';",
      "```",
      "carriage\rreturn and \\u005b literal",
    ].join("\n");
    const frame = frameMemoryAgentBenchChunk(chunk);
    const state = await heapifyResolvedDocument({
      rootDropId: "frame-test",
      content: frame.sourceText,
    });

    expect(state.documentNodes).toHaveLength(1);
    expect(state.documentNodes?.[0]).toMatchObject({
      kind: "paragraph",
      text: frame.nodeText,
    });
    expect(decodeMemoryAgentBenchChunk(state.documentNodes![0]!.text)).toBe(chunk);
  });

  it.each(["plain", "", "nul\u0000byte", "emoji 😀", "[x](https://example.test)"])(
    "round-trips %p without an ASCII chunk identifier",
    (chunk) => {
      const frame = frameMemoryAgentBenchChunk(chunk);
      expect(decodeMemoryAgentBenchChunk(frame.nodeText)).toBe(chunk);
      expect(frame.nodeText).not.toMatch(/chunk[-_:]?\d+/i);
    },
  );

  it.each(["plain", "⟦𝙽𝙳𝙱𝟷⟧not-json", "⟦𝙽𝙳𝙱𝟷⟧\"pl\\u0061in\""])(
    "rejects invalid frame %p",
    (value) => {
      expect(() => decodeMemoryAgentBenchChunk(value)).toThrow();
    },
  );
});

describe("createMemoryAgentBenchRun", () => {
  it("uses predecessor -1 and rejects out-of-order input before the network", async () => {
    const client = createClient();
    const run = await createMemoryAgentBenchRun({
      client,
      eventId: () => "event-0",
    });

    await expect(run.ingest(1, "late")).rejects.toThrow("Expected chunk index 0");
    expect(client.applyDiff).not.toHaveBeenCalled();
    await run.ingest(0, "first");
    expect(client.applyDiff.mock.calls[0]?.[0].metadata?.followsSeq).toBe(-1);
  });

  it("retries the exact body with stable identity and accepts a duplicate receipt", async () => {
    const client = createClient();
    const attempts: unknown[] = [];
    client.applyDiff.mockImplementation(async (request) => {
      attempts.push(request);
      if (attempts.length === 1) {
        throw new Error("response lost");
      }
      return receipt(request.eventId!, 0, 1, "duplicate");
    });
    const run = await createMemoryAgentBenchRun({
      client,
      eventId: () => "stable-event",
    });

    await expect(run.ingest(0, "same body")).rejects.toThrow("response lost");
    await expect(run.ingest(0, "different body")).rejects.toThrow(
      "exact same chunk body",
    );
    const duplicate = await run.ingest(0, "same body");

    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(duplicate).toMatchObject({
      status: "duplicate",
      sequence: 0,
      snapshotId: 1,
    });
    expect(run.trace()).toMatchObject({
      nextIndex: 1,
      finalEventSequence: 0,
      snapshotId: 1,
    });
  });

  it.each([
    [
      "event",
      (response: DropDiffAppendResponse) => ({
        ...response,
        acknowledgements: [
          { ...response.acknowledgements[0]!, eventId: "other" },
        ],
      }),
    ],
    [
      "branch",
      (response: DropDiffAppendResponse) => ({ ...response, branchId: "other" }),
    ],
    [
      "sequence",
      (response: DropDiffAppendResponse) => ({
        ...response,
        acknowledgements: [{ ...response.acknowledgements[0]!, seq: 2 }],
      }),
    ],
    [
      "snapshot",
      (response: DropDiffAppendResponse) => ({
        ...response,
        acknowledgements: [{ ...response.acknowledgements[0]!, snapshotId: 2 }],
      }),
    ],
  ] as const)(
    "rejects a mismatched %s acknowledgement without advancing",
    async (_name, mutate) => {
      const client = createClient();
      client.applyDiff.mockImplementation(async (request) =>
        mutate(receipt(request.eventId!, 0, 1)),
      );
      const run = await createMemoryAgentBenchRun({
        client,
        eventId: () => "event-0",
      });

      await expect(run.ingest(0, "body")).rejects.toThrow("acknowledgement identity");
      expect(run.trace()).toMatchObject({ nextIndex: 0, offset: 22, snapshotId: 0 });
    },
  );

  it("rejects an invalid totalStored receipt without advancing", async () => {
    const client = createClient();
    client.applyDiff.mockImplementation(async (request) => ({
      ...receipt(request.eventId!, 0, 1),
      totalStored: 2,
    }));
    const run = await createMemoryAgentBenchRun({
      client,
      eventId: () => "event-0",
    });

    await expect(run.ingest(0, "body")).rejects.toThrow(
      "acknowledgement identity",
    );
    expect(run.trace()).toMatchObject({
      nextIndex: 0,
      offset: 22,
      snapshotId: 0,
      finalEventSequence: -1,
      receipts: [],
    });
  });

  it("requires finalize, materializes outside retrieval, validates topK, and preserves rank", async () => {
    const client = createClient();
    const first = frameMemoryAgentBenchChunk("rank one");
    const second = frameMemoryAgentBenchChunk("rank two");
    client.applyDiff.mockImplementation(async (request) =>
      receipt(request.eventId!, 0, 1),
    );
    client.getBranchContent.mockResolvedValue({
      rootDropId,
      branchId,
      snapshotId: 1,
      headEventSeq: 0,
      content: `# Memory Agent Bench\n\n${first.sourceText}`,
    });
    client.queryBranch
      .mockResolvedValueOnce(resolved(1))
      .mockResolvedValueOnce(resolved(1, [second.nodeText, first.nodeText]));
    const times = [10, 30, 40, 47];
    const run = await createMemoryAgentBenchRun({
      client,
      now: () => times.shift()!,
      eventId: () => "event-0",
    });
    await run.ingest(0, "rank one");

    await expect(run.retrieve("rank", 2)).rejects.toThrow("Finalize");
    await run.finalize();
    expect(client.queryBranch).toHaveBeenCalledTimes(1);
    await expect(run.retrieve("rank", 0)).rejects.toThrow("topK");
    await expect(run.retrieve("rank", 101)).rejects.toThrow("topK");
    const result = await run.retrieve("rank", 2);

    expect(result.chunks).toEqual(["rank two", "rank one"]);
    expect(result.constructionTiming).toEqual({
      startedAtMs: 10,
      finalizedAtMs: 30,
      elapsedMs: 20,
    });
    expect(result.retrievalTiming).toEqual({
      startedAtMs: 40,
      finishedAtMs: 47,
      elapsedMs: 7,
    });
    expect(client.queryBranch.mock.calls[0]?.[0]).toMatchObject({
      snapshotId: 1,
      kind: "paragraph",
      top: 1,
    });
    expect(client.queryBranch.mock.calls[1]?.[0]).toMatchObject({
      snapshotId: 1,
      kind: "paragraph",
      top: 2,
      query: "rank",
    });
  });

  it("rejects a final snapshot mismatch", async () => {
    const client = createClient();
    const frame = frameMemoryAgentBenchChunk("body");
    client.applyDiff.mockImplementation(async (request) =>
      receipt(request.eventId!, 0, 1),
    );
    client.getBranchContent.mockResolvedValue({
      rootDropId,
      branchId,
      snapshotId: 2,
      headEventSeq: 0,
      content: `# Memory Agent Bench\n\n${frame.sourceText}`,
    });
    const run = await createMemoryAgentBenchRun({
      client,
      eventId: () => "event-0",
    });
    await run.ingest(0, "body");
    await expect(run.finalize()).rejects.toThrow("Final branch identity");
    expect(client.queryBranch).not.toHaveBeenCalled();
  });
});

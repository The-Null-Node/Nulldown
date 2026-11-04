import { describe, expect, it } from "@jest/globals";
import { queryResolvedDocumentNodes } from "../../../shared/drop/resolved/query/document";
import { heapifyResolvedDocument } from "../../../shared/drop/resolved/heapify/document";
import { queryResolvedDocumentSource } from "./resolved-query";

describe("selected resolved document query", () => {
  it("matches shared heap semantics for filters, ancestors and snapshot identity", async () => {
    const source = {
      rootDropId: "root",
      branchId: "branch",
      snapshotId: 4,
      headEventSeq: 8,
      content: "# Alpha\n\n## Beta\n\nA useful paragraph.",
      events: [],
    };
    const state = await heapifyResolvedDocument({
      ...source,
      sourceSeqRange: { from: 0, to: source.headEventSeq },
    });
    const expected = queryResolvedDocumentNodes(state, {
      q: "useful",
      limit: 3,
      includeAncestors: true,
    });
    const actual = await queryResolvedDocumentSource(source, {
      q: "useful",
      limit: 3,
      includeAncestors: true,
    });
    expect(actual.nodes).toEqual(expected);
    expect(actual).toMatchObject({
      rootDropId: source.rootDropId,
      branchId: source.branchId,
      snapshotId: source.snapshotId,
      stale: false,
      heapGenerated: true,
    });
    expect(actual.sourceContentHash).toMatch(/^sha256:/);
  });

  it("applies event range, changedOnly and metadata provenance from selected events", async () => {
    const source = {
      rootDropId: "root",
      branchId: "branch",
      snapshotId: 2,
      headEventSeq: 1,
      content: "# Changed title\n\nStable paragraph.",
      events: [
        {
          eventId: "event-1",
          dropId: "root",
          seq: 1,
          snapshotId: 2,
          sourceClientId: "writer",
          createdAt: 5,
          ops: [{ type: "insert" as const, start: 2, end: 2, text: "X" }],
          metadata: { kind: "agent.edit" as const, labels: ["selected"] },
        },
      ],
    };
    const result = await queryResolvedDocumentSource(source, {
      fromSeq: 1,
      toSeq: 1,
      changedOnly: true,
    });
    expect(result.nodes.length).toBeGreaterThan(0);
    expect(
      result.nodes.every((entry) =>
        entry.eventRefs?.some((ref) => ref.eventId === "event-1"),
      ),
    ).toBe(true);
    expect(result.nodes[0]?.eventRefs?.[0]?.metadata).toEqual({
      kind: "agent.edit",
      labels: ["selected"],
    });
  });
});

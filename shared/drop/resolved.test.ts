import { createHash } from "crypto";
import {
  NULLDOWN_CONTEXT_TOKEN_PREFIX,
  applyResolvedNodeDeltaOps,
  buildBranchSnapshotSourceHashKey,
  buildMarkdownSourceHashKey,
  changedRangesFromDropDiffEvents,
  createResolvedHeapDeltaRecord,
  createResolvedNodeRefRecords,
  decodeNulldownContextToken,
  diffResolvedNodeRefs,
  encodeNulldownContextToken,
  getNextResolvedChecklistItem,
  heapifyResolvedDocument,
  heapifyResolvedRuntimeRefs,
  heapifyResolvedChecklist,
  hashBranchSnapshotSource,
  hashMarkdownSource,
  queryResolvedDocumentNodes,
  queryResolvedRuntimeNodes,
  readResolvedNulldownState,
  writeResolvedNulldownState,
  isNulldownContextToken,
  isNulldownSourceHash,
  isResolvedHeapDeltaRecord,
  isResolvedNodeDeltaOp,
  isResolvedNodeRefRecord,
  isResolvedNulldownState,
  isResolvedPriorityFactRecord,
  RESOLVED_DOCUMENT_RESOLVER_ID,
  RESOLVED_DOCUMENT_RESOLVER_VERSION,
  RESOLVED_HEAP_DELTA_RECORD_VERSION,
  RESOLVED_NODE_REF_RECORD_VERSION,
  RESOLVED_PRIORITY_FACT_RECORD_VERSION,
  type NulldownContextToken,
} from "./resolved";

const createMemoryStore = () => {
  const values = new Map<string, string>();
  return {
    values,
    async get(key: string) {
      const value = values.get(key);
      if (value === undefined) return null;
      return {
        async json() {
          return JSON.parse(value) as unknown;
        },
      };
    },
    async put(key: string, value: string) {
      values.set(key, value);
    },
  };
};

describe("resolved drop helpers", () => {
  const expectedHash = (content: string): string =>
    `sha256:${createHash("sha256")
      .update(`nulldown.source-content.v1\n${content}`)
      .digest("base64url")}`;

  it("hashes markdown and branch snapshot content with the same source-content algorithm", async () => {
    const markdownHash = await hashMarkdownSource("hello");
    const snapshotHash = await hashBranchSnapshotSource({
      rootDropId: "root-1",
      branchId: "clone_anonymous",
      snapshotId: 7,
      content: "hello",
    });

    expect(markdownHash).toBe(expectedHash("hello"));
    expect(snapshotHash).toBe(markdownHash);
    expect(isNulldownSourceHash(markdownHash)).toBe(true);
    expect(isNulldownSourceHash("sha1:bad")).toBe(false);
  });

  it("builds stable source hash keys", () => {
    expect(buildMarkdownSourceHashKey("drop-1")).toBe("drop:drop-1:content");
    expect(
      buildBranchSnapshotSourceHashKey({
        rootDropId: "root-1",
        branchId: "clone_anonymous",
        snapshotId: 2,
      }),
    ).toBe("branch:root-1:clone_anonymous:snapshot:2:content");
  });

  it("encodes and decodes ndctx context tokens", async () => {
    const sourceHash = await hashMarkdownSource("plan");
    const token: NulldownContextToken = {
      version: 1,
      rootDropId: "root-1",
      branchId: "clone_anonymous",
      snapshotId: 5,
      checklistDropId: "checklist-1",
      resolvedHeapIds: ["heap-1"],
      sourceHashes: {
        [buildMarkdownSourceHashKey("checklist-1")]: sourceHash,
      },
      queryHints: [
        {
          dropId: "checklist-1",
          kind: "checklist.next",
        },
      ],
    };

    const encoded = encodeNulldownContextToken(token);

    expect(encoded.startsWith(NULLDOWN_CONTEXT_TOKEN_PREFIX)).toBe(true);
    expect(decodeNulldownContextToken(encoded)).toEqual(token);
    expect(isNulldownContextToken(token)).toBe(true);
  });

  it("rejects malformed context tokens", async () => {
    const sourceHash = await hashMarkdownSource("plan");

    expect(decodeNulldownContextToken("bad.v1.abc")).toBeNull();
    expect(
      isNulldownContextToken({
        version: 1,
        rootDropId: "root-1",
        resolvedHeapIds: [],
        sourceHashes: { bad: sourceHash.replace("sha256:", "sha1:") },
        queryHints: [],
      }),
    ).toBe(false);
    expect(
      decodeNulldownContextToken(`${NULLDOWN_CONTEXT_TOKEN_PREFIX}not-valid%`),
    ).toBeNull();
  });

  it("heapifies markdown checklists with phases and source ranges", async () => {
    const content = [
      "# Phase One",
      "",
      "- [x] Done item",
      "- [ ] Next item",
      "",
      "## Phase Two",
      "1. [ ] Numbered item",
    ].join("\n");

    const state = await heapifyResolvedChecklist({
      rootDropId: "root-1",
      branchId: "clone_anonymous",
      snapshotId: 3,
      content,
      resolvedAt: 123,
    });

    expect(state.version).toBe(1);
    expect(state.rootDropId).toBe("root-1");
    expect(state.branchId).toBe("clone_anonymous");
    expect(state.snapshotId).toBe(3);
    expect(state.resolvedAt).toBe(123);
    expect(state.title).toBe("Phase One");
    expect(state.sourceContentHash).toBe(expectedHash(content));
    expect(state.checklistItems).toEqual([
      expect.objectContaining({
        text: "Done item",
        checked: true,
        phase: "Phase One",
        sourceRange: { start: 13, end: 28 },
        sourceHash: state.sourceContentHash,
      }),
      expect.objectContaining({
        text: "Next item",
        checked: false,
        phase: "Phase One",
        sourceRange: { start: 29, end: 44 },
        sourceHash: state.sourceContentHash,
      }),
      expect.objectContaining({
        text: "Numbered item",
        checked: false,
        phase: "Phase Two",
        sourceHash: state.sourceContentHash,
      }),
    ]);
  });

  it("queries the next unchecked checklist item by importance then source order", async () => {
    const state = await heapifyResolvedChecklist({
      rootDropId: "root-1",
      content: "- [ ] Low\n- [ ] High\n- [x] Done",
    });
    const [low, high] = state.checklistItems ?? [];

    expect(
      getNextResolvedChecklistItem({
        ...state,
        importance: {
          [low.id]: 1,
          [high.id]: 10,
        },
      })?.text,
    ).toBe("High");

    expect(getNextResolvedChecklistItem(state)?.text).toBe("Low");
    expect(
      getNextResolvedChecklistItem({
        ...state,
        checklistItems: state.checklistItems?.map((item) => ({
          ...item,
          checked: true,
        })),
      }),
    ).toBeNull();
  });

  it("heapifies nullplug dependency refs and UI response refs", async () => {
    const content = [
      "# Runtime refs",
      "```nd(id=\"child-drop-1\")",
      "```",
      "```form(id=\"approval\")",
      "Approve this patch.",
      "```",
    ].join("\n");
    const state = await heapifyResolvedRuntimeRefs({
      rootDropId: "root-1",
      branchId: "clone_anonymous",
      snapshotId: 9,
      content,
      resolvedAt: 123,
      uiPrimitives: [
        {
          kind: "action",
          id: "approve-action",
          label: "Approve",
          source: {
            rootDropId: "root-1",
            branchId: "clone_anonymous",
            callId: "call-1",
          },
        },
      ],
      uiResponseFacts: [
        {
          version: 1,
          kind: "ui.response",
          id: "response-1",
          primitiveId: "approval",
          createdAt: 122,
          source: { rootDropId: "root-1", branchId: "clone_anonymous", callId: "call-1" },
          data: { approved: true },
          proposedDiffs: { version: 1, events: [] },
        },
      ],
      uiStatePatchFacts: [
        {
          version: 1,
          kind: "ui.state.patch",
          id: "patch-1",
          callId: "call-1",
          createdAt: 123,
          source: { rootDropId: "root-1", branchId: "clone_anonymous", callId: "call-1" },
          patch: [{ op: "set", path: ["approved"], value: true }],
        },
      ],
    });

    expect(isResolvedNulldownState(state)).toBe(true);
    expect(state.pluginRefs).toEqual([
      expect.objectContaining({ pluginId: "nd", dropId: "child-drop-1" }),
      expect.objectContaining({ pluginId: "form" }),
    ]);
    expect(state.responseRefs).toEqual([
      expect.objectContaining({
        id: "response-1",
        primitiveId: "approval",
        proposedDiffEventCount: 0,
      }),
    ]);
    expect(state.runtimeNodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "nullplug.ref", pluginId: "nd" }),
        expect.objectContaining({ kind: "ui.primitive", primitiveId: "approve-action" }),
        expect.objectContaining({ kind: "ui.response", primitiveId: "approval" }),
        expect.objectContaining({ kind: "ui.state", callId: "call-1" }),
      ]),
    );
    expect(
      queryResolvedRuntimeNodes(state, { q: "approve", kinds: ["ui.primitive", "ui.response"] })
        .map((entry) => entry.node.kind),
    ).toEqual(["ui.response", "ui.primitive"]);
  });

  it("heapifies general document nodes for headings, sections, links, and nullplugs", async () => {
    const content = [
      "# Runtime Plan",
      "",
      "## Policy",
      "Policy text with [docs](https://nulldown.app/d/aN8B4B).",
      "- [ ] Add audit sidecars",
      "```nd(id=\"child-drop-1\")",
      "```",
      "",
      "## Registry",
      "Signed manifests live here.",
    ].join("\n");

    const state = await heapifyResolvedDocument({
      rootDropId: "root-1",
      branchId: "clone_anonymous",
      snapshotId: 5,
      content,
      resolvedAt: 123,
    });

    expect(state.documentNodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "document.title", text: "Runtime Plan" }),
        expect.objectContaining({ kind: "heading", text: "Policy" }),
        expect.objectContaining({ kind: "section", headingPath: ["Runtime Plan", "Policy"] }),
        expect.objectContaining({ kind: "link.ref", href: "https://nulldown.app/d/aN8B4B" }),
        expect.objectContaining({ kind: "checklist.item", text: "Add audit sidecars", checked: false }),
        expect.objectContaining({ kind: "nullplug.ref", pluginId: "nd", dropId: "child-drop-1" }),
      ]),
    );
  });

  it("queries top document nodes by text and diff event metadata", async () => {
    const content = [
      "# Runtime Plan",
      "",
      "## Policy",
      "Policy text about mutation downgrade rules.",
      "",
      "## Registry",
      "Signed manifests live here.",
    ].join("\n");
    const state = await heapifyResolvedDocument({
      rootDropId: "root-1",
      branchId: "clone_anonymous",
      snapshotId: 6,
      content,
    });
    const policyStart = content.indexOf("Policy text");
    const [eventRef] = changedRangesFromDropDiffEvents([
      {
        eventId: "evt-policy",
        seq: 12,
        dropId: "root-1",
        sourceClientId: "agent",
        createdAt: 456,
        metadata: {
          kind: "agent.edit",
          intent: "Explain mutation downgrade policy.",
          labels: ["policy", "mutation"],
        },
        ops: [
          {
            type: "insert",
            start: policyStart,
            end: policyStart,
            text: "Policy ",
          },
        ],
      },
    ]);

    const results = queryResolvedDocumentNodes(state, {
      q: "mutation policy",
      events: [eventRef],
      limit: 3,
    });

    expect(results[0].node.text).toContain("Policy");
    expect(results[0].reasons).toEqual(
      expect.arrayContaining(["query-match", "changed-range-overlap"]),
    );
    expect(results[0].eventRefs?.[0].metadata?.intent).toBe(
      "Explain mutation downgrade policy.",
    );
  });

  it("validates semantic heap delta, node ref, and priority fact records", async () => {
    const nodeHash = await hashMarkdownSource("node payload");
    const sourceHash = await hashMarkdownSource("# Runtime Plan");
    const nodeRef = {
      version: RESOLVED_NODE_REF_RECORD_VERSION,
      nodeId: "heading:root:0:14",
      kind: "heading",
      nodeHash,
      sourceHash,
      sourceRange: { start: 0, end: 14 },
      parentId: "document.title:root:0:14",
      text: "Runtime Plan",
      importance: 3.3,
    };

    expect(isResolvedNodeRefRecord(nodeRef)).toBe(true);
    expect(isResolvedNodeRefRecord({ ...nodeRef, nodeHash: "sha1:bad" })).toBe(false);

    const checkpointDelta = {
      version: RESOLVED_HEAP_DELTA_RECORD_VERSION,
      rootDropId: "root-1",
      branchId: "clone_anonymous",
      snapshotId: 2,
      resolverId: RESOLVED_DOCUMENT_RESOLVER_ID,
      resolverVersion: RESOLVED_DOCUMENT_RESOLVER_VERSION,
      parent: {
        rootDropId: "root-1",
        branchId: "clone_anonymous",
        snapshotId: 1,
        resolverId: RESOLVED_DOCUMENT_RESOLVER_ID,
      },
      sourceContentHash: sourceHash,
      sourceSeqRange: { from: 0, to: 3 },
      resolvedAt: 123,
      checkpointed: true,
      nodeRefs: [nodeRef],
      diffRefs: [
        {
          seq: 3,
          eventId: "evt-3",
          sourceClientId: "agent",
          createdAt: 122,
          metadata: { kind: "agent.edit", labels: ["heap/ref-delta"] },
          changedRanges: [{ start: 0, end: 14 }],
        },
      ],
      priorityFactIds: ["fact-1"],
      title: "Runtime Plan",
      summary: "Delta for the runtime plan heading.",
    };

    const upsertOp = { op: "upsert", ref: nodeRef };
    const deleteOp = {
      op: "delete",
      nodeId: "paragraph:root:20:40",
      previousNodeHash: nodeHash,
    };
    expect(isResolvedNodeDeltaOp(upsertOp)).toBe(true);
    expect(isResolvedNodeDeltaOp(deleteOp)).toBe(true);
    expect(isResolvedNodeDeltaOp({ op: "delete" })).toBe(false);

    const compactDelta = {
      ...checkpointDelta,
      checkpointed: false,
      nodeRefs: undefined,
      nodeOps: [upsertOp, deleteOp],
    };

    expect(isResolvedHeapDeltaRecord(checkpointDelta)).toBe(true);
    expect(isResolvedHeapDeltaRecord(compactDelta)).toBe(true);
    expect(isResolvedHeapDeltaRecord({ ...checkpointDelta, nodeRefs: [{ ...nodeRef, version: 2 }] })).toBe(false);
    expect(isResolvedHeapDeltaRecord({ ...compactDelta, nodeOps: [{ op: "delete" }] })).toBe(false);

    const priorityFact = {
      version: RESOLVED_PRIORITY_FACT_RECORD_VERSION,
      factId: "fact-1",
      rootDropId: "root-1",
      branchId: "clone_anonymous",
      resolverId: RESOLVED_DOCUMENT_RESOLVER_ID,
      targetKind: "node",
      targetId: nodeRef.nodeId,
      priority: 0.9,
      createdAt: 124,
      sourceSeq: 3,
      sourceEventId: "evt-3",
      reason: "Important planning heading.",
      labels: ["heap/priority-fact"],
      metadata: { confidence: 0.95 },
    };

    expect(isResolvedPriorityFactRecord(priorityFact)).toBe(true);
    expect(isResolvedPriorityFactRecord({ ...priorityFact, targetKind: "drop" })).toBe(false);
    expect(isResolvedPriorityFactRecord({ ...priorityFact, metadata: { bad: undefined } })).toBe(false);
  });

  it("builds and applies compact semantic node ref deltas", async () => {
    const parent = await heapifyResolvedDocument({
      rootDropId: "root-1",
      branchId: "clone_anonymous",
      snapshotId: 1,
      content: "# Plan\n\nOld paragraph",
      resolvedAt: 123,
    });
    const current = await heapifyResolvedDocument({
      rootDropId: "root-1",
      branchId: "clone_anonymous",
      snapshotId: 2,
      content: "# Plan\n\nNew paragraph",
      resolvedAt: 124,
    });

    const parentRefs = await createResolvedNodeRefRecords(parent);
    const currentRefs = await createResolvedNodeRefRecords(current);
    const ops = diffResolvedNodeRefs(parentRefs, currentRefs);
    const compactDelta = await createResolvedHeapDeltaRecord({
      state: current,
      parent: {
        rootDropId: "root-1",
        branchId: "clone_anonymous",
        snapshotId: 1,
        resolverId: RESOLVED_DOCUMENT_RESOLVER_ID,
      },
      parentNodeRefs: parentRefs,
      checkpointed: false,
    });

    expect(ops.some((op) => op.op === "upsert")).toBe(true);
    expect(ops.some((op) => op.op === "delete")).toBe(true);
    expect(compactDelta).toEqual(
      expect.objectContaining({ checkpointed: false, nodeOps: ops }),
    );
    expect(compactDelta?.nodeRefs).toBeUndefined();
    expect(applyResolvedNodeDeltaOps(parentRefs, ops)).toEqual(currentRefs);
  });

  it("reads and writes resolved heap records", async () => {
    const store = createMemoryStore();
    const state = await heapifyResolvedRuntimeRefs({
      rootDropId: "root-1",
      branchId: "clone_anonymous",
      snapshotId: 4,
      content: "```nd\nchild-drop-2\n```",
      resolvedAt: 123,
    });

    const key = await writeResolvedNulldownState(store, state);
    expect(key).toBe(
      "__drop_resolved_heap__/root-1/clone_anonymous/nulldown.resolved.runtime-refs/4.json",
    );
    await expect(
      readResolvedNulldownState(
        store,
        "root-1",
        "clone_anonymous",
        "nulldown.resolved.runtime-refs",
        4,
      ),
    ).resolves.toEqual(state);
  });
});

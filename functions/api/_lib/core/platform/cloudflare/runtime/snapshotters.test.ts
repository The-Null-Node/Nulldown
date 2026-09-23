import { jest } from "@jest/globals";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { onRequest } from "../../../../../diff/[id]";
import { resolveBranchForActor } from "../../../../branches/lifecycle";
import {
  accountId,
  createPostRequest,
  createSeededBucket,
  makeEvent,
  MemoryD1Database,
  rootDropId,
} from "../../../../diffs/testing/storage-fixture";
import { createCloudflareRuntimeDataStore } from "../runtime-data/store";
import { createNulleditPolicyDecisionFactDataKey } from "../../../../../../../src/server/nulledit/snapshotters/policy-observer";
import { createResolvedHeapDataKey } from "../../../../../../../src/server/nulledit/data-keys/resolved";
import type {
  NulleditPolicyDecisionFactRecord,
  NulleditSnapshotDiffRefRecord,
  NulleditSnapshotFrameRecord,
} from "../../../../../../../src/server/nulledit/types";
import {
  RESOLVED_DOCUMENT_RESOLVER_ID,
  RESOLVED_RUNTIME_REFS_RESOLVER_ID,
} from "../../../../../../../shared/drop/resolved/constants";
import type {
  ResolvedDocumentNode,
  ResolvedNulldownState,
  ResolvedPriorityFactRecord,
  ResolvedRuntimeNode,
} from "../../../../../../../shared/drop/resolved/types";
import {
  nullplugUiResponseFactKey,
  type NullplugUiResponseFact,
} from "../../../../../../../shared/nullplug/ui";
import type {
  NullMemFactRecord,
  NullMemProcedureRecord,
} from "../../../../../../../shared/nullmem/records";

describe("Cloudflare snapshotter persistence contracts", () => {
  let infoSpy: jest.SpiedFunction<typeof console.info>;
  let warnSpy: jest.SpiedFunction<typeof console.warn>;
  let errorSpy: jest.SpiedFunction<typeof console.error>;
  let debugSpy: jest.SpiedFunction<typeof console.debug>;

  beforeEach(() => {
    infoSpy = jest.spyOn(console, "info").mockImplementation(() => {});
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    debugSpy = jest.spyOn(console, "debug").mockImplementation(() => {});
  });

  afterEach(() => {
    infoSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    debugSpy.mockRestore();
  });

  it("persists built-in Nulledit snapshot records through the data store", async () => {
    const bucket = createSeededBucket();
    const db = new MemoryD1Database();
    const { branch } = await resolveBranchForActor(
      bucket as unknown as R2Bucket,
      rootDropId,
      accountId,
      null,
    );
    const responseFact: NullplugUiResponseFact = {
      version: 1,
      kind: "ui.response",
      id: "response-persist",
      primitiveId: "persist-action",
      createdAt: 105,
      source: {
        rootDropId,
        branchId: branch.branchId,
        snapshotId: 1,
        callId: "call-persist",
      },
      data: { persisted: true },
    };
    bucket.seed(
      nullplugUiResponseFactKey(responseFact),
      JSON.stringify(responseFact),
    );
    const event = makeEvent({
      eventId: "evt-data-put",
      sourceClientId: "writer-data-put",
      text: "Persist me",
      createdAt: 106,
      metadata: {
        kind: "agent.edit",
        intent: "Persist snapshot frame and diff ref.",
        args: {
          priority: 4,
          summary: "Persist the verified snapshot projection.",
          procedureCandidate: {
            goal: "Persist a verified snapshot projection",
            summary:
              "Apply the marked diff and retain the immutable diff reference.",
            completed: true,
          },
        },
        labels: ["data.put", "snapshotter", "nullmem/procedure-candidate"],
        confidence: 0.8,
        policyDecisionRef: "policy-decision-persist",
      },
    });
    const waitUntilPromises: Promise<void>[] = [];

    const response = await onRequest({
      request: createPostRequest([event]),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        DB: db as unknown as D1Database,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
      },
      params: { id: rootDropId },
      waitUntil: (promise: Promise<void>) => {
        waitUntilPromises.push(promise);
      },
    } as unknown as Parameters<typeof onRequest>[0]);
    const body = (await response.json()) as {
      branchId: string;
      snapshotId: number;
    };

    expect(response.status).toBe(200);
    expect(waitUntilPromises).toHaveLength(1);
    await Promise.all(waitUntilPromises);
    expect(db.batchCalls.some((count) => count > 8)).toBe(true);

    const data = createCloudflareRuntimeDataStore({
      R2_BUCKET: bucket as unknown as R2Bucket,
      DB: db as unknown as D1Database,
    });
    const frame = await data.get<NulleditSnapshotFrameRecord>({
      namespace: "nulledit",
      collection: "snapshot_frames",
      scope: { rootDropId, branchId: body.branchId },
      id: String(body.snapshotId),
    });
    const diffRef = await data.get<NulleditSnapshotDiffRefRecord>({
      namespace: "nulledit",
      collection: "snapshot_diff_refs",
      scope: {
        rootDropId,
        branchId: body.branchId,
        snapshotId: body.snapshotId,
      },
      id: event.eventId,
    });

    expect(frame).toEqual(
      expect.objectContaining({
        version: 1,
        rootDropId,
        branchId: body.branchId,
        snapshotId: body.snapshotId,
        content: "Persist me",
        textLength: "Persist me".length,
      }),
    );
    expect(frame?.acceptedDiffRefs).toEqual([
      {
        rootDropId,
        branchId: body.branchId,
        eventId: event.eventId,
        seq: 0,
        ref: `<diff:${event.eventId}>`,
        snapshotId: body.snapshotId,
      },
    ]);
    expect(diffRef).toEqual(
      expect.objectContaining({
        version: 1,
        rootDropId,
        branchId: body.branchId,
        snapshotId: body.snapshotId,
        sourceClientId: event.sourceClientId,
        metadata: event.metadata,
      }),
    );
    expect(diffRef?.ref).toEqual({
      rootDropId,
      branchId: body.branchId,
      eventId: event.eventId,
      seq: 0,
      ref: `<diff:${event.eventId}>`,
      snapshotId: body.snapshotId,
    });

    const resolvedHeap = await data.get<ResolvedNulldownState>(
      createResolvedHeapDataKey({
        rootDropId,
        branchId: body.branchId,
        snapshotId: body.snapshotId,
        resolverId: RESOLVED_DOCUMENT_RESOLVER_ID,
      }),
    );
    const resolvedNodes = await data.query<ResolvedDocumentNode>({
      namespace: "resolved",
      collection: "document_nodes",
      scope: {
        rootDropId,
        branchId: body.branchId,
        snapshotId: body.snapshotId,
        resolverId: RESOLVED_DOCUMENT_RESOLVER_ID,
      },
      indexes: [{ name: "kind", value: "paragraph" }],
      text: "Persist",
    });
    expect(resolvedHeap).toEqual(
      expect.objectContaining({
        rootDropId,
        branchId: body.branchId,
        snapshotId: body.snapshotId,
        resolverId: RESOLVED_DOCUMENT_RESOLVER_ID,
      }),
    );
    expect(resolvedHeap?.documentNodes?.length).toBeGreaterThan(0);
    expect(resolvedNodes).toEqual([
      expect.objectContaining({ kind: "paragraph", text: "Persist me" }),
    ]);

    const runtimeHeap = await data.get<ResolvedNulldownState>(
      createResolvedHeapDataKey({
        rootDropId,
        branchId: body.branchId,
        snapshotId: body.snapshotId,
        resolverId: RESOLVED_RUNTIME_REFS_RESOLVER_ID,
      }),
    );
    const runtimeNodes = await data.query<ResolvedRuntimeNode>({
      namespace: "resolved",
      collection: "runtime_nodes",
      scope: {
        rootDropId,
        branchId: body.branchId,
        snapshotId: body.snapshotId,
        resolverId: RESOLVED_RUNTIME_REFS_RESOLVER_ID,
      },
      indexes: [{ name: "kind", value: "ui.response" }],
      text: "persist-action",
    });
    expect(runtimeHeap).toEqual(
      expect.objectContaining({
        rootDropId,
        branchId: body.branchId,
        snapshotId: body.snapshotId,
        resolverId: RESOLVED_RUNTIME_REFS_RESOLVER_ID,
      }),
    );
    expect(runtimeHeap?.runtimeNodes).toEqual([
      expect.objectContaining({
        kind: "ui.response",
        primitiveId: "persist-action",
      }),
    ]);
    expect(runtimeNodes).toEqual([
      expect.objectContaining({
        kind: "ui.response",
        primitiveId: "persist-action",
      }),
    ]);

    const priorityFacts = [...db.priorityFacts.values()].map(
      (entry) => JSON.parse(entry) as ResolvedPriorityFactRecord,
    );
    expect(priorityFacts).toEqual([
      expect.objectContaining({
        factId: `priority:diff:${rootDropId}:${body.branchId}:${event.eventId}`,
        rootDropId,
        branchId: body.branchId,
        targetKind: "diff",
        targetId: event.eventId,
        priority: 4,
        sourceSeq: 0,
        sourceEventId: event.eventId,
        reason: "Persist snapshot frame and diff ref.",
        labels: ["data.put", "snapshotter", "nullmem/procedure-candidate"],
      }),
    ]);

    const policyFact = await data.get<NulleditPolicyDecisionFactRecord>(
      createNulleditPolicyDecisionFactDataKey({
        rootDropId,
        branchId: body.branchId,
        snapshotId: body.snapshotId,
        factId: `policy:diff:${rootDropId}:${body.branchId}:${event.eventId}`,
      }),
    );
    const policyFacts = await data.query<NulleditPolicyDecisionFactRecord>({
      namespace: "nulledit",
      collection: "policy_decision_facts",
      scope: {
        rootDropId,
        branchId: body.branchId,
        snapshotId: body.snapshotId,
      },
    });
    expect(policyFact).toEqual(
      expect.objectContaining({
        version: 1,
        factId: `policy:diff:${rootDropId}:${body.branchId}:${event.eventId}`,
        rootDropId,
        branchId: body.branchId,
        snapshotId: body.snapshotId,
        sourceEventId: event.eventId,
        sourceSeq: 0,
        sourceClientId: event.sourceClientId,
        policyDecisionRef: "policy-decision-persist",
        metadataKind: "agent.edit",
        intent: "Persist snapshot frame and diff ref.",
        labels: ["data.put", "snapshotter", "nullmem/procedure-candidate"],
        confidence: 0.8,
        args: expect.objectContaining({ priority: 4 }),
        text: expect.stringContaining("policy-decision-persist"),
      }),
    );
    expect(policyFacts).toEqual([policyFact]);

    const nullmemRecords = [...db.nullmemRecords.values()].map(
      (entry) =>
        JSON.parse(entry) as NullMemFactRecord | NullMemProcedureRecord,
    );
    const nullmemFacts = nullmemRecords.filter(
      (entry): entry is NullMemFactRecord => entry.kind === "fact",
    );
    const nullmemProcedures = nullmemRecords.filter(
      (entry): entry is NullMemProcedureRecord => entry.kind === "procedure",
    );
    expect(nullmemFacts).toEqual([
      expect.objectContaining({
        recordId: `memfact:observed-branch-append:${rootDropId}:${body.branchId}:${body.snapshotId}:${event.eventId}:${event.eventId}`,
        rootDropId,
        branchId: body.branchId,
        targetKind: "snapshot",
        targetId: String(body.snapshotId),
        labels: [
          "snapshotter/observable-chain",
          "nullmem/observed-append",
          "branch-append",
        ],
        metadata: expect.objectContaining({
          eventIds: [event.eventId],
          eventCount: 1,
          snapshotId: body.snapshotId,
          parentSnapshotId: 0,
          totalStored: 1,
          deduplicatedCount: 0,
          seqRange: { from: 0, to: 0 },
        }),
      }),
    ]);
    expect(nullmemFacts[0]?.sourceRefs).toEqual(
      expect.arrayContaining([
        { kind: "branch", rootDropId, branchId: body.branchId },
        {
          kind: "snapshot",
          rootDropId,
          branchId: body.branchId,
          snapshotId: body.snapshotId,
        },
        {
          kind: "diff",
          rootDropId,
          branchId: body.branchId,
          eventId: event.eventId,
          seq: 0,
        },
      ]),
    );
    expect(nullmemProcedures).toEqual([
      expect.objectContaining({
        recordId: `memproc:auto-accepted-diff:${rootDropId}:${body.branchId}:${event.eventId}`,
        goal: "Persist a verified snapshot projection",
        outcome: "success",
        labels: [
          "procedure-memory",
          "auto-extracted",
          "needs-review",
          "accepted-diff",
        ],
        sourceRefs: [
          { kind: "branch", rootDropId, branchId: body.branchId },
          {
            kind: "diff",
            rootDropId,
            branchId: body.branchId,
            eventId: event.eventId,
            seq: 0,
          },
        ],
      }),
    ]);
  });
});

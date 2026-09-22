import { describe, expect, it, jest } from "@jest/globals";
import type { R2Bucket } from "@cloudflare/workers-types";
import { appendEventsToBranch } from "../../../../_lib/nulledit/service";
import { resolveBranchForActor } from "../../../../_lib/branches/lifecycle";
import { NULLDOWN_ACCOUNT_ID_HEADER } from "../../../../../../shared/drop/branch";
import { RESOLVED_RUNTIME_REFS_RESOLVER_ID } from "../../../../../../shared/drop/resolved/constants";
import {
  nullplugUiResponseFactKey,
  nullplugUiStatePatchFactKey,
} from "../../../../../../shared/nullplug/ui";
import { onRequest as onResolvedQueryRequest } from "./query";
import { onRequest as onResolvedUpdateRequest } from "./update";
import {
  accountId,
  createSeededBucket,
  makeEvent,
  rootDropId,
} from "../../../../_lib/resolved/heap/testing/route-fixture";

describe("resolved route integration contracts", () => {
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

  it("returns top resolved document nodes with diff metadata refs", async () => {
    const bucket = createSeededBucket();
    const { branch } = await resolveBranchForActor(
      bucket as unknown as R2Bucket,
      rootDropId,
      accountId,
      null,
    );
    const content = [
      "# Runtime Plan",
      "",
      "## Policy",
      "Policy mutation downgrade rules live here.",
      '```nd(id="child-drop-1")',
      "```",
    ].join("\n");
    await appendEventsToBranch(bucket as unknown as R2Bucket, branch, [
      makeEvent(content),
    ]);

    const response = await onResolvedQueryRequest({
      request: new Request(
        `https://nulldown.test/api/branches/${rootDropId}/${branch.branchId}/resolved/query?q=mutation&fromSeq=0&toSeq=0&k=20`,
      ),
      env: { R2_BUCKET: bucket as unknown as R2Bucket },
      params: { rootId: rootDropId, branchId: branch.branchId },
    } as unknown as Parameters<typeof onResolvedQueryRequest>[0]);

    const body = (await response.json()) as {
      heapGenerated: boolean;
      nodes: Array<{
        node: { kind: string; text: string; pluginId?: string };
        reasons: string[];
        eventRefs?: Array<{ metadata?: { intent?: string } }>;
      }>;
    };

    expect(response.status).toBe(200);
    expect(body.heapGenerated).toBe(true);
    expect(body.nodes[0].node.text).toContain("Policy");
    expect(body.nodes[0].reasons).toEqual(
      expect.arrayContaining(["query-match", "changed-range-overlap"]),
    );
    expect(body.nodes[0].eventRefs?.[0].metadata?.intent).toBe(
      "Add policy section and nullplug reference.",
    );
    expect(body.nodes.some((entry) => entry.node.pluginId === "nd")).toBe(true);
  });

  it("returns compact resolved document items for the snapshotterId projection", async () => {
    const bucket = createSeededBucket();
    const { branch } = await resolveBranchForActor(
      bucket as unknown as R2Bucket,
      rootDropId,
      accountId,
      null,
    );
    const content = [
      "# Compact Projection Plan",
      "",
      "## Policy",
      "Compact projection policy content should be available without full node payloads.",
      "This extra sentence makes the source section long enough to prove text trimming stays bounded.",
    ].join("\n");
    await appendEventsToBranch(bucket as unknown as R2Bucket, branch, [
      makeEvent(content),
    ]);

    const response = await onResolvedQueryRequest({
      request: new Request(
        `https://nulldown.test/api/branches/${rootDropId}/${branch.branchId}/resolved/query?snapshotterId=nulledit.resolved-document&q=projection&k=2`,
      ),
      env: { R2_BUCKET: bucket as unknown as R2Bucket },
      params: { rootId: rootDropId, branchId: branch.branchId },
    } as unknown as Parameters<typeof onResolvedQueryRequest>[0]);

    const body = (await response.json()) as {
      items: Array<{
        id: string;
        kind: string;
        score: number;
        text: string;
        sourceRange: { start: number; end: number };
        node?: unknown;
      }>;
      nodes?: unknown[];
      snapshotterId?: string;
    };

    expect(response.status).toBe(200);
    expect(body.snapshotterId).toBe("nulledit.resolved-document");
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items[0]).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        kind: expect.any(String),
        score: expect.any(Number),
        text: expect.stringMatching(/projection/i),
        sourceRange: expect.objectContaining({
          start: expect.any(Number),
          end: expect.any(Number),
        }),
      }),
    );
    expect(body.items[0].node).toBeUndefined();
    expect(body.nodes).toBeUndefined();
    expect(JSON.stringify(body).length).toBeLessThan(2_000);
  });

  it("updates and queries runtime resolved heap nodes from durable UI facts", async () => {
    const bucket = createSeededBucket();
    const { branch } = await resolveBranchForActor(
      bucket as unknown as R2Bucket,
      rootDropId,
      accountId,
      null,
    );
    const appendResult = await appendEventsToBranch(
      bucket as unknown as R2Bucket,
      branch,
      [makeEvent(["# UI Runtime", '```form(id="approval")', "```"].join("\n"))],
    );
    const snapshotId =
      appendResult.snapshot?.snapshotId ?? appendResult.branch.headSnapshotId;
    const responseFact = {
      version: 1 as const,
      kind: "ui.response" as const,
      id: "response-approval",
      primitiveId: "approval",
      createdAt: 124,
      source: {
        rootDropId,
        branchId: appendResult.branch.branchId,
        snapshotId,
        callId: "call-approval",
      },
      data: { approved: true },
    };
    const statePatchFact = {
      version: 1 as const,
      kind: "ui.state.patch" as const,
      id: "patch-approval",
      callId: "call-approval",
      createdAt: 125,
      source: {
        rootDropId,
        branchId: appendResult.branch.branchId,
        snapshotId,
        callId: "call-approval",
      },
      patch: [{ op: "set" as const, path: ["approved"], value: true }],
    };
    bucket.seed(
      nullplugUiResponseFactKey(responseFact),
      JSON.stringify(responseFact),
    );
    bucket.seed(
      nullplugUiStatePatchFactKey(statePatchFact),
      JSON.stringify(statePatchFact),
    );

    const update = await onResolvedUpdateRequest({
      request: new Request(
        `https://nulldown.test/api/branches/${rootDropId}/${branch.branchId}/resolved/update`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            [NULLDOWN_ACCOUNT_ID_HEADER]: accountId,
          },
          body: JSON.stringify({
            resolverId: RESOLVED_RUNTIME_REFS_RESOLVER_ID,
            uiPrimitives: [
              {
                kind: "action",
                id: "approve-action",
                label: "Approve",
                source: responseFact.source,
              },
            ],
          }),
        },
      ),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
      },
      params: { rootId: rootDropId, branchId: branch.branchId },
    } as unknown as Parameters<typeof onResolvedUpdateRequest>[0]);

    const updateBody = (await update.json()) as {
      updated: Array<{ resolverId: string; nodeCount: number }>;
    };
    expect(update.status).toBe(200);
    expect(updateBody.updated[0]).toEqual(
      expect.objectContaining({
        resolverId: RESOLVED_RUNTIME_REFS_RESOLVER_ID,
        nodeCount: expect.any(Number),
      }),
    );

    const query = await onResolvedQueryRequest({
      request: new Request(
        `https://nulldown.test/api/branches/${rootDropId}/${branch.branchId}/resolved/query?resolverId=${encodeURIComponent(
          RESOLVED_RUNTIME_REFS_RESOLVER_ID,
        )}&q=approve&kind=ui.primitive,ui.response,ui.state`,
        { headers: { [NULLDOWN_ACCOUNT_ID_HEADER]: accountId } },
      ),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
      },
      params: { rootId: rootDropId, branchId: branch.branchId },
    } as unknown as Parameters<typeof onResolvedQueryRequest>[0]);

    const queryBody = (await query.json()) as {
      nodes: Array<{
        node: { kind: string; primitiveId?: string; callId?: string };
      }>;
    };
    expect(query.status).toBe(200);
    expect(queryBody.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          node: expect.objectContaining({ kind: "ui.response" }),
        }),
        expect.objectContaining({
          node: expect.objectContaining({ kind: "ui.primitive" }),
        }),
        expect.objectContaining({
          node: expect.objectContaining({ kind: "ui.state" }),
        }),
      ]),
    );
  });
});

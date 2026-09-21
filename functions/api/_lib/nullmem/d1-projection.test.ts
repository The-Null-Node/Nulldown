import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { NULLDOWN_ACCOUNT_ID_HEADER } from "../../../../shared/drop/branch";
import {
  NULLPLUG_INVOKE_CONTENT_TYPE,
  writeRemoteNullplugManifest,
} from "../../../../shared/nullplug/registry";
import { writeBranch } from "../branches/storage/repository";
import { createMemoryRuntimeDataStore } from "../../../../src/server/memory-data-store";
import { createNullMemFreshnessWatermarkKey } from "../../../../src/server/nulledit";
import {
  createNullMemFact,
  createNullMemProcedure,
  deleteNullMemRecord,
  queryNullMem,
} from "./http";
import { createNullMemService } from "./service";
import {
  MemoryD1Database,
  MemoryR2Bucket,
  createBranch,
} from "../core/d1/testing/metadata-fixture";

describe("D1 NullMem metadata contracts", () => {
  it("stores and queries branch-scoped NullMem facts and procedures", async () => {
    const bucket = new MemoryR2Bucket();
    const db = new MemoryD1Database();
    const branch = createBranch();

    await bucket.put(
      branch.rootDropId,
      JSON.stringify({ content: "# Memory Root" }),
    );
    await writeBranch(
      bucket as unknown as R2Bucket,
      branch,
      db as unknown as D1Database,
    );

    const headers = {
      "Content-Type": "application/json",
      [NULLDOWN_ACCOUNT_ID_HEADER]: branch.writerAccountId ?? "acct_1",
    };
    const env = {
      R2_BUCKET: bucket as unknown as R2Bucket,
      DB: db as unknown as D1Database,
      ALLOW_INSECURE_ACCOUNT_HEADER: "1",
    };
    const params = { rootId: branch.rootDropId, branchId: branch.branchId };

    await writeRemoteNullplugManifest(
      bucket as unknown as R2Bucket,
      {
        version: 1,
        status: "active",
        createdAt: 123,
        updatedAt: 456,
        registeredBy: "acct_1",
        manifest: {
          id: "remote.summary",
          version: "1.0.0",
          endpoint: "https://plugins.nulldown.test/summary",
          contentType: NULLPLUG_INVOKE_CONTENT_TYPE,
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
          permissions: [
            { kind: "drop.read", scope: "caller" },
            { kind: "network", hosts: ["api.nulldown.test"] },
          ],
          description: "Summarizes a linked drop.",
        },
      },
      ["plugins.nulldown.test", "api.nulldown.test"],
    );

    const factResponse = await createNullMemFact(
      env,
      params,
      new Request("https://example.test/api/memory/facts", {
        method: "POST",
        headers,
        body: JSON.stringify({
          title: "Approval nullplug guidance",
          text: "Use the approval action nullplug when an agent needs explicit user confirmation.",
          labels: ["capability-memory", "nullplug"],
          priority: 2,
        }),
      }),
    );
    expect(factResponse.status).toBe(201);

    const procedureResponse = await createNullMemProcedure(
      env,
      params,
      new Request("https://example.test/api/memory/procedures", {
        method: "POST",
        headers,
        body: JSON.stringify({
          goal: "Build a stateful approval widget",
          summary:
            "Query memory, choose the approval nullplug, write UI state facts, then verify runtime refs.",
          steps: [
            {
              index: 0,
              kind: "query",
              name: "nd branch memory query",
              description:
                "Find prior capability guidance before selecting a nullplug.",
              callHint: {
                target: "cli",
                name: "nd branch memory query",
                argsSummary:
                  "Query the current branch for approval nullplug guidance.",
              },
              exitCondition: "Approval nullplug guidance is found.",
              minStep: true,
              status: "success",
              resultSummary: "Found approval nullplug guidance.",
            },
            {
              index: 1,
              kind: "mcp.call",
              name: "branch_query",
              description:
                "Verify runtime refs for the branch after choosing the nullplug.",
              status: "partial",
              resultSummary: "Runtime refs still need verification.",
            },
          ],
          outcome: "success",
          labels: ["procedure-memory", "nullplug"],
        }),
      }),
    );
    expect(procedureResponse.status).toBe(201);
    const procedureBody = (await procedureResponse.json()) as {
      record: { recordId: string };
    };
    expect(db.nullmemRecords.size).toBe(2);

    const queryResponse = await queryNullMem(
      env,
      params,
      new Request(
        "https://example.test/api/memory/query?query=approval%20nullplug&limit=5",
        {
          headers: {
            [NULLDOWN_ACCOUNT_ID_HEADER]: branch.writerAccountId ?? "acct_1",
          },
        },
      ),
    );
    const queryBody = (await queryResponse.json()) as {
      capsules: Array<{ kind: string; summary: string }>;
    };

    expect(queryResponse.status).toBe(200);
    expect(queryBody.capsules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "fact",
          summary: expect.stringContaining("approval action"),
        }),
        expect.objectContaining({
          kind: "procedure",
          summary: expect.stringContaining("runtime refs"),
        }),
      ]),
    );

    const stepResponse = await queryNullMem(
      env,
      params,
      new Request(
        `https://example.test/api/memory/query?procedureId=${encodeURIComponent(procedureBody.record.recordId)}&afterStep=-1&stepLimit=1&includeRecords=false`,
        {
          headers: {
            [NULLDOWN_ACCOUNT_ID_HEADER]: branch.writerAccountId ?? "acct_1",
          },
        },
      ),
    );
    const stepBody = (await stepResponse.json()) as {
      records: unknown[];
      procedureSteps: Array<{
        procedureId: string;
        step: { index: number; description?: string; exitCondition?: string };
        nextCursor?: number;
        remainingSteps: number;
      }>;
    };

    expect(stepResponse.status).toBe(200);
    expect(stepBody.records).toEqual([]);
    expect(stepBody.procedureSteps).toEqual([
      expect.objectContaining({
        procedureId: procedureBody.record.recordId,
        step: expect.objectContaining({
          index: 0,
          description: expect.stringContaining(
            "Find prior capability guidance",
          ),
          exitCondition: "Approval nullplug guidance is found.",
        }),
        nextCursor: 0,
        remainingSteps: 1,
      }),
    ]);

    const capabilityResponse = await queryNullMem(
      env,
      params,
      new Request(
        "https://example.test/api/memory/query?query=branch%20memory%20query&kind=capability",
        {
          headers: {
            [NULLDOWN_ACCOUNT_ID_HEADER]: branch.writerAccountId ?? "acct_1",
          },
        },
      ),
    );
    const capabilityBody = (await capabilityResponse.json()) as {
      capsules: Array<{ recordId: string }>;
    };

    expect(capabilityResponse.status).toBe(200);
    expect(capabilityBody.capsules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recordId: "capability:tool:nd-branch-memory-query",
        }),
      ]),
    );

    const cliCapabilityResponse = await queryNullMem(
      env,
      params,
      new Request(
        "https://example.test/api/memory/query?query=atomic%20branch%20diff&kind=capability&labels=nd-cli",
        {
          headers: {
            [NULLDOWN_ACCOUNT_ID_HEADER]: branch.writerAccountId ?? "acct_1",
          },
        },
      ),
    );
    const cliCapabilityBody = (await cliCapabilityResponse.json()) as {
      capsules: Array<{ recordId: string; title?: string }>;
    };

    expect(cliCapabilityResponse.status).toBe(200);
    expect(cliCapabilityBody.capsules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recordId: "capability:tool:nd-diff-apply",
          title: "Apply atomic branch diff",
        }),
      ]),
    );

    const mcpCapabilityResponse = await queryNullMem(
      env,
      params,
      new Request(
        "https://example.test/api/memory/query?query=semantic%20branch%20heap&kind=capability&labels=mcp-catalog",
        {
          headers: {
            [NULLDOWN_ACCOUNT_ID_HEADER]: branch.writerAccountId ?? "acct_1",
          },
        },
      ),
    );
    const mcpCapabilityBody = (await mcpCapabilityResponse.json()) as {
      capsules: Array<{ recordId: string; title?: string }>;
    };

    expect(mcpCapabilityResponse.status).toBe(200);
    expect(mcpCapabilityBody.capsules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recordId: "capability:mcp:nulldown:branch_query",
          title: "Nulldown MCP: Query Branch Heap",
        }),
      ]),
    );

    const remoteCapabilityResponse = await queryNullMem(
      env,
      params,
      new Request(
        "https://example.test/api/memory/query?query=summarizes%20linked%20drop&kind=capability&labels=remote-nullplug",
        {
          headers: {
            [NULLDOWN_ACCOUNT_ID_HEADER]: branch.writerAccountId ?? "acct_1",
          },
        },
      ),
    );
    const remoteCapabilityBody = (await remoteCapabilityResponse.json()) as {
      capsules: Array<{ recordId: string; title?: string }>;
    };

    expect(remoteCapabilityResponse.status).toBe(200);
    expect(remoteCapabilityBody.capsules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recordId: "capability:nullplug:remote.summary:1.0.0",
          title: "Remote nullplug: remote.summary",
        }),
      ]),
    );

    const themeCapabilityResponse = await queryNullMem(
      env,
      params,
      new Request(
        "https://example.test/api/memory/query?query=warm%20parchment&kind=capability&labels=theme-catalog",
        {
          headers: {
            [NULLDOWN_ACCOUNT_ID_HEADER]: branch.writerAccountId ?? "acct_1",
          },
        },
      ),
    );
    const themeCapabilityBody = (await themeCapabilityResponse.json()) as {
      capsules: Array<{ recordId: string; title?: string }>;
    };

    expect(themeCapabilityResponse.status).toBe(200);
    expect(themeCapabilityBody.capsules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recordId: "capability:theme:gruvbox-light",
          title: "Theme: Gruvbox Light",
        }),
      ]),
    );

    const createdFact = (await factResponse.json()) as {
      record: { recordId: string };
    };
    const deleteResponse = await deleteNullMemRecord(
      env,
      { ...params, recordId: createdFact.record.recordId },
      new Request(
        `https://example.test/api/memory/${encodeURIComponent(createdFact.record.recordId)}`,
        {
          method: "DELETE",
          headers,
        },
      ),
    );
    expect(deleteResponse.status).toBe(200);

    const afterDeleteResponse = await queryNullMem(
      env,
      params,
      new Request(
        "https://example.test/api/memory/query?query=approval%20action&kind=fact",
        {
          headers,
        },
      ),
    );
    const afterDeleteBody = (await afterDeleteResponse.json()) as {
      capsules: Array<{ recordId: string }>;
    };
    expect(afterDeleteBody.capsules).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ recordId: createdFact.record.recordId }),
      ]),
    );
  });

  it("limits anonymous NullMem queries to explicitly public records", async () => {
    const bucket = new MemoryR2Bucket();
    const db = new MemoryD1Database();
    const branch = createBranch();
    const env = {
      R2_BUCKET: bucket as unknown as R2Bucket,
      DB: db as unknown as D1Database,
      ALLOW_INSECURE_ACCOUNT_HEADER: "1",
    };
    const params = { rootId: branch.rootDropId, branchId: branch.branchId };
    const authenticatedHeaders = {
      "Content-Type": "application/json",
      [NULLDOWN_ACCOUNT_ID_HEADER]: branch.writerAccountId ?? "acct_1",
    };

    await bucket.put(
      branch.rootDropId,
      JSON.stringify({ content: "# Memory Root" }),
    );
    await writeBranch(
      bucket as unknown as R2Bucket,
      branch,
      db as unknown as D1Database,
    );

    const privateFact = await createNullMemFact(
      env,
      params,
      new Request("https://example.test/api/memory/facts", {
        method: "POST",
        headers: authenticatedHeaders,
        body: JSON.stringify({
          title: "Private memory",
          text: "This record must remain authenticated-only.",
          labels: ["account-recovery"],
        }),
      }),
    );
    expect(privateFact.status).toBe(201);

    const publicFact = await createNullMemFact(
      env,
      params,
      new Request("https://example.test/api/memory/facts", {
        method: "POST",
        headers: authenticatedHeaders,
        body: JSON.stringify({
          title: "Public memory",
          text: "This record is safe for unauthenticated agent retrieval.",
          labels: ["account-recovery", "public-memory"],
        }),
      }),
    );
    const publicBody = (await publicFact.json()) as {
      record: { recordId: string };
    };

    const anonymousQuery = await queryNullMem(
      env,
      params,
      new Request("https://example.test/api/memory/query?query=record"),
    );
    const anonymousBody = (await anonymousQuery.json()) as {
      query: { labels: string[] };
      records: Array<{ recordId: string }>;
    };

    expect(anonymousQuery.status).toBe(200);
    expect(anonymousBody.query.labels).toEqual(["public-memory"]);
    expect(anonymousBody.records).toEqual([
      expect.objectContaining({ recordId: publicBody.record.recordId }),
    ]);

    const anonymousWrite = await createNullMemFact(
      env,
      params,
      new Request("https://example.test/api/memory/facts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "Unauthenticated writes remain forbidden.",
        }),
      }),
    );
    expect(anonymousWrite.status).toBe(401);

    const anonymousDelete = await deleteNullMemRecord(
      env,
      { ...params, recordId: publicBody.record.recordId },
      new Request(
        `https://example.test/api/memory/${encodeURIComponent(publicBody.record.recordId)}`,
        { method: "DELETE" },
      ),
    );
    expect(anonymousDelete.status).toBe(401);
  });

  it("uses freshness watermarks before falling back to branch heads", async () => {
    const bucket = new MemoryR2Bucket();
    const db = new MemoryD1Database();
    const data = createMemoryRuntimeDataStore();
    const branch = createBranch({ headSnapshotId: 3 });

    await writeBranch(
      bucket as unknown as R2Bucket,
      branch,
      db as unknown as D1Database,
    );
    await data.put(
      createNullMemFreshnessWatermarkKey(branch.rootDropId, branch.branchId),
      {
        version: 1,
        rootDropId: branch.rootDropId,
        branchId: branch.branchId,
        headSnapshotId: 7,
        previousSnapshotId: 6,
        updatedAt: 1_700_000_000_000,
        acceptedEventCount: 1,
      },
    );

    const memory = createNullMemService({
      blobs: bucket as unknown as R2Bucket,
      sql: db as unknown as D1Database,
      data,
    });

    await memory.createFact({
      rootDropId: branch.rootDropId,
      branchId: branch.branchId,
      fact: {
        title: "Watermark-backed freshness",
        text: "This cites snapshot 5.",
        sourceRefs: [
          {
            kind: "snapshot",
            rootDropId: branch.rootDropId,
            branchId: branch.branchId,
            snapshotId: 5,
          },
        ],
      },
    });

    const result = await memory.query({
      rootDropId: branch.rootDropId,
      branchId: branch.branchId,
      q: "Watermark-backed freshness",
      kind: "fact",
      includeFreshness: true,
    });

    expect(result.freshness).toEqual([
      expect.objectContaining({
        status: "snapshot-outdated",
        currentSnapshotId: 7,
        outdatedSnapshotRefs: [5],
      }),
    ]);
  });
});

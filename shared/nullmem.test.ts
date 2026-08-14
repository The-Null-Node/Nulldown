import {
  NULLMEM_RECORD_VERSION,
  createBuiltInMcpCapabilityRecords,
  createBuiltInNullMemCapabilities,
  createCliOperationalCapabilityRecords,
  createRemoteNullplugCapabilityRecord,
  createThemeCatalogCapabilityRecord,
  createThemeCatalogCapabilityRecords,
  isNullMemCapabilityRecord,
  isNullMemFactRecord,
  isNullMemProcedureRecord,
  nullMemRecordText,
  nullMemRecordToCapsule,
  evaluateNullMemFreshness,
  evaluateNullMemFreshnessBatch,
  hasStaleMemoryLabel,
  extractSupersedesFromLabels,
  collectSnapshotSourceIds,
} from "./nullmem";
import { NULLPLUG_INVOKE_CONTENT_TYPE } from "./nullplug/registry";

describe("NullMem contracts", () => {
  it("validates capability, procedure, and fact records", () => {
    const capability = createBuiltInNullMemCapabilities(100)[0];
    expect(isNullMemCapabilityRecord(capability)).toBe(true);
    expect(
      isNullMemCapabilityRecord({ ...capability, capabilityKind: "unknown" }),
    ).toBe(false);

    const procedure = {
      version: NULLMEM_RECORD_VERSION,
      kind: "procedure" as const,
      recordId: "procedure:deploy-smoke",
      rootDropId: "root_1",
      branchId: "owner",
      goal: "Deploy and smoke a feature",
      summary: "Build, deploy, smoke, and update tracking drops.",
      steps: [
        {
          index: 0,
          kind: "test" as const,
          name: "bun run test",
          description: "Run the focused verification step.",
          callHint: {
            target: "cli" as const,
            name: "bun run test",
            argsSummary: "Focused NullMem tests.",
          },
          exitCondition: "Focused tests pass.",
          minStep: true,
          status: "success" as const,
          resultSummary: "Focused tests passed.",
        },
      ],
      outcome: "success" as const,
      labels: ["procedure-memory"],
      sourceRefs: [
        { kind: "branch" as const, rootDropId: "root_1", branchId: "owner" },
      ],
      createdAt: 100,
    };
    expect(isNullMemProcedureRecord(procedure)).toBe(true);
    expect(isNullMemProcedureRecord({ ...procedure, outcome: "maybe" })).toBe(
      false,
    );
    expect(nullMemRecordText(procedure)).toContain("Focused tests pass");

    const fact = {
      version: NULLMEM_RECORD_VERSION,
      kind: "fact" as const,
      recordId: "fact:note",
      rootDropId: "root_1",
      branchId: "owner",
      text: "Use memory query before choosing a nullplug.",
      labels: ["nullmem/plan"],
      priority: 0.8,
      createdAt: 101,
    };
    expect(isNullMemFactRecord(fact)).toBe(true);
    expect(isNullMemFactRecord({ ...fact, metadata: { bad: undefined } })).toBe(
      false,
    );
  });

  it("creates searchable text and compact capsules", () => {
    const capability = createBuiltInNullMemCapabilities(100).find(
      (record) => record.capabilityId === "nd branch memory query",
    );
    if (!capability)
      throw new Error("Expected built-in memory query capability.");

    expect(nullMemRecordText(capability)).toContain("prior procedures");
    expect(nullMemRecordToCapsule(capability)).toEqual(
      expect.objectContaining({
        recordId: "capability:tool:nd-branch-memory-query",
        kind: "capability",
        title: "Query branch memory",
      }),
    );

    const deleteCapability = createBuiltInNullMemCapabilities(100).find(
      (record) => record.capabilityId === "nd branch memory delete",
    );
    expect(deleteCapability).toEqual(
      expect.objectContaining({
        recordId: "capability:tool:nd-branch-memory-delete",
        labels: expect.arrayContaining(["stale-memory"]),
      }),
    );

    const approvalCapability = createBuiltInNullMemCapabilities(100).find(
      (record) => record.capabilityId === "approval",
    );
    expect(approvalCapability).toEqual(
      expect.objectContaining({
        recordId: "capability:nullplug:approval",
        capabilityKind: "nullplug",
        labels: expect.arrayContaining(["approval", "human-in-the-loop"]),
      }),
    );

    expect(createCliOperationalCapabilityRecords(100)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recordId: "capability:tool:nd-diff-apply",
          labels: expect.arrayContaining(["atomic-diff"]),
        }),
        expect.objectContaining({
          recordId: "capability:tool:nd-branch-memory-procedure",
          labels: expect.arrayContaining(["procedure-memory"]),
        }),
      ]),
    );

    expect(createBuiltInMcpCapabilityRecords(100)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recordId: "capability:mcp:nulldown:branch_query",
          capabilityKind: "mcp",
          capabilityId: "nulldown.branch_query",
          labels: expect.arrayContaining(["mcp-catalog", "semantic-query"]),
          sourceRefs: [{ kind: "mcp", toolId: "nulldown/branch_query" }],
        }),
        expect.objectContaining({
          recordId: "capability:mcp:nulldown:memory_procedure",
          labels: expect.arrayContaining(["procedure-memory"]),
        }),
      ]),
    );
  });

  it("converts remote nullplug registry records into capability memory", () => {
    const capability = createRemoteNullplugCapabilityRecord({
      version: 1,
      status: "active",
      createdAt: 200,
      updatedAt: 250,
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
    });

    expect(isNullMemCapabilityRecord(capability)).toBe(true);
    expect(capability).toEqual(
      expect.objectContaining({
        recordId: "capability:nullplug:remote.summary:1.0.0",
        capabilityKind: "nullplug",
        capabilityId: "remote.summary",
        capabilityVersion: "1.0.0",
        labels: expect.arrayContaining([
          "remote-nullplug",
          "permission:network",
        ]),
        metadata: expect.objectContaining({
          endpoint: "https://plugins.nulldown.test/summary",
          registeredBy: "acct_1",
        }),
      }),
    );
    expect(nullMemRecordText(capability)).toContain("Summarizes a linked drop");
  });

  it("converts bundled theme catalog entries into capability memory", () => {
    const capability = createThemeCatalogCapabilityRecord(
      {
        id: "paper-light",
        name: "Paper Light",
        author: "Nulldown",
        lastModified: "2026-01-31",
        description: "Soft paper palette for daylight writing.",
        version: "1.0.0",
        syntax: "oneLight",
        mode: "light",
      },
      300,
    );

    expect(isNullMemCapabilityRecord(capability)).toBe(true);
    expect(capability).toEqual(
      expect.objectContaining({
        recordId: "capability:theme:paper-light",
        capabilityKind: "theme",
        capabilityId: "paper-light",
        capabilityVersion: "1.0.0",
        labels: expect.arrayContaining([
          "theme-catalog",
          "theme-mode:light",
          "syntax:oneLight",
        ]),
        sourceRefs: [{ kind: "theme", themeId: "paper-light" }],
      }),
    );
    expect(nullMemRecordText(capability)).toContain("daylight writing");
    expect(createThemeCatalogCapabilityRecords()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ recordId: "capability:theme:monokai" }),
      ]),
    );
  });

  it("evaluates freshness for facts with snapshot refs and stale labels", () => {
    const factCurrent = {
      version: NULLMEM_RECORD_VERSION,
      kind: "fact" as const,
      recordId: "memfact:current",
      rootDropId: "r1",
      branchId: "b1",
      text: "Current work at snapshot 10.",
      sourceRefs: [
        {
          kind: "snapshot" as const,
          rootDropId: "r1",
          branchId: "b1",
          snapshotId: 10,
        },
      ],
      labels: ["current-work"],
      createdAt: 200,
    };
    const factStale = {
      version: NULLMEM_RECORD_VERSION,
      kind: "fact" as const,
      recordId: "memfact:stale",
      rootDropId: "r1",
      branchId: "b1",
      text: "Old work at snapshot 5.",
      sourceRefs: [
        {
          kind: "snapshot" as const,
          rootDropId: "r1",
          branchId: "b1",
          snapshotId: 5,
        },
      ],
      labels: ["current-work"],
      createdAt: 100,
    };
    const factExplicit = {
      version: NULLMEM_RECORD_VERSION,
      kind: "fact" as const,
      recordId: "memfact:explicit",
      rootDropId: "r1",
      branchId: "b1",
      text: "Marked stale.",
      labels: ["stale-memory"],
      createdAt: 150,
    };
    const factSuperseded = {
      version: NULLMEM_RECORD_VERSION,
      kind: "fact" as const,
      recordId: "memfact:old",
      rootDropId: "r1",
      branchId: "b1",
      text: "Superseded fact.",
      labels: ["supersedes:memfact:old"],
      createdAt: 90,
    };

    const res = evaluateNullMemFreshnessBatch({
      records: [factCurrent, factStale, factExplicit, factSuperseded],
      currentSnapshotId: 10,
      knownSupersedingIds: ["memfact:old"],
    });

    expect(res.byRecordId["memfact:current"].status).toBe("fresh");
    expect(res.byRecordId["memfact:stale"].status).toBe("snapshot-outdated");
    expect(res.byRecordId["memfact:explicit"].status).toBe("explicit-stale");
    expect(res.byRecordId["memfact:old"].status).toBe("superseded");

    expect(hasStaleMemoryLabel(factExplicit)).toBe(true);
    expect(extractSupersedesFromLabels(factSuperseded.labels)).toContain(
      "memfact:old",
    );
    expect(collectSnapshotSourceIds(factStale)).toEqual([5]);
  });

  it("evaluates cross-branch snapshot heads via snapshotHeads option", () => {
    const factCrossBranch = {
      version: NULLMEM_RECORD_VERSION,
      kind: "fact" as const,
      recordId: "memfact:cross",
      rootDropId: "planRoot",
      branchId: "planBranch",
      text: "Cites plan snapshot 3.",
      sourceRefs: [
        {
          kind: "snapshot" as const,
          rootDropId: "planRoot",
          branchId: "planBranch",
          snapshotId: 3,
        },
      ],
      createdAt: 300,
    };

    const res = evaluateNullMemFreshnessBatch({
      records: [factCrossBranch],
      snapshotHeads: { "planRoot:planBranch": 8 },
    });

    expect(res.byRecordId["memfact:cross"].status).toBe("snapshot-outdated");
    expect(res.byRecordId["memfact:cross"].outdatedSnapshotRefs).toEqual([3]);
  });

  it("reports unverifiable when no snapshot head context is provided", () => {
    const factNoContext = {
      version: NULLMEM_RECORD_VERSION,
      kind: "fact" as const,
      recordId: "memfact:nocontext",
      rootDropId: "r2",
      branchId: "b2",
      text: "Has branch ref but no snapshot head to compare.",
      sourceRefs: [
        { kind: "branch" as const, rootDropId: "r2", branchId: "b2" },
      ],
      createdAt: 400,
    };

    const res = evaluateNullMemFreshnessBatch({
      records: [factNoContext],
    });

    expect(res.byRecordId["memfact:nocontext"].status).toBe("unverifiable");
  });
});

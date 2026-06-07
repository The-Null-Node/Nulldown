import {
  NULLMEM_RECORD_VERSION,
  createBuiltInNullMemCapabilities,
  createRemoteNullplugCapabilityRecord,
  isNullMemCapabilityRecord,
  isNullMemFactRecord,
  isNullMemProcedureRecord,
  nullMemRecordText,
  nullMemRecordToCapsule,
} from "./nullmem";

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
          status: "success" as const,
          resultSummary: "Focused tests passed.",
        },
      ],
      outcome: "success" as const,
      labels: ["procedure-memory"],
      sourceRefs: [{ kind: "branch" as const, rootDropId: "root_1", branchId: "owner" }],
      createdAt: 100,
    };
    expect(isNullMemProcedureRecord(procedure)).toBe(true);
    expect(isNullMemProcedureRecord({ ...procedure, outcome: "maybe" })).toBe(false);

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
    expect(isNullMemFactRecord({ ...fact, metadata: { bad: undefined } })).toBe(false);
  });

  it("creates searchable text and compact capsules", () => {
    const capability = createBuiltInNullMemCapabilities(100).find(
      (record) => record.capabilityId === "nd branch memory query",
    );
    if (!capability) throw new Error("Expected built-in memory query capability.");

    expect(nullMemRecordText(capability)).toContain("prior procedures");
    expect(nullMemRecordToCapsule(capability)).toEqual(
      expect.objectContaining({
        recordId: "capability:tool:nd-branch-memory-query",
        kind: "capability",
        title: "Query branch memory",
      }),
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
        labels: expect.arrayContaining(["remote-nullplug", "permission:network"]),
        metadata: expect.objectContaining({
          endpoint: "https://plugins.nulldown.test/summary",
          registeredBy: "acct_1",
        }),
      }),
    );
    expect(nullMemRecordText(capability)).toContain("Summarizes a linked drop");
  });
});

import { jest } from "@jest/globals";
import { createNulldownClient } from "./nulldownClient";

const branch = {
  rootDropId: "umdxfMQlcKzq",
  branchId: "clone_account:91c993ac-2c8c-46d6-aaec-5d31e610a2b7",
  snapshotId: 7,
  resolverId: "document",
  resolverVersion: "1",
  sourceContentHash: "hash",
  stale: false,
  heapGenerated: false,
  nodeCount: 20,
  items: [{ text: "Populated plan" }],
};
const strategyRef = {
  kind: "branch",
  rootDropId: branch.rootDropId,
  branchId: branch.branchId,
};

describe("readStrategy", () => {
  const setup = (body: unknown, status = 200, json = true) => {
    const fetcher = jest.fn<typeof fetch>().mockResolvedValue(
      new Response(json ? JSON.stringify(body) : String(body), {
        status,
        headers: { "Content-Type": json ? "application/json" : "text/plain" },
      }),
    );
    return {
      fetcher,
      client: createNulldownClient({ baseUrl: "http://local.test", fetch: fetcher }),
    };
  };

  it("labels title-only roots without body/text duplication or branch discovery", async () => {
    const { client, fetcher } = setup("# Title only", 200, false);
    expect(await client.readStrategy({ id: branch.rootDropId })).toEqual({
      read: "root",
      rootDropId: branch.rootDropId,
      revision: null,
      partial: false,
      truncated: false,
      data: "# Title only",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe(
      `http://local.test/api/get/${branch.rootDropId}`,
    );
    expect(fetcher.mock.calls[0][1]?.method).toBeUndefined();
  });

  it("reads only the explicit populated branch and forwards filters, version and budget", async () => {
    const { client, fetcher } = setup(branch);
    const result = await client.readStrategy({
      id: branch.rootDropId,
      branchId: branch.branchId,
      query: "next task",
      top: 3,
      snapshotId: 7,
      preview: false,
      maxTokens: 800,
    });
    expect(result).toMatchObject({
      read: "branch",
      rootDropId: branch.rootDropId,
      branchId: branch.branchId,
      snapshotId: 7,
      partial: true,
      truncated: false,
      data: branch,
    });
    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect(url.pathname).toBe(
      `/api/branches/${branch.rootDropId}/${branch.branchId}/resolved/query`,
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: "next task",
      k: "3",
      snapshotId: "7",
      snapshotterId: "nulledit.resolved-document",
      maxTokens: "800",
      preview: "false",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1]?.method).toBeUndefined();
  });

  it.each([403, 404, 500])("does not fall back after HTTP %s", async (status) => {
    const { client, fetcher } = setup({ error: "unavailable" }, status);
    await expect(
      client.readStrategy({ id: branch.rootDropId, branchId: branch.branchId }),
    ).rejects.toThrow("unavailable");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([branch.rootDropId, branch.rootDropId.slice(0, 6)])(
    "accepts the explicit canonical root or its short alias in one request: %s",
    async (id) => {
      const { client, fetcher } = setup(branch);
      await expect(client.readStrategy({ id, branchId: branch.branchId }))
        .resolves.toMatchObject({ rootDropId: branch.rootDropId, read: "branch" });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["otherRoot123", "otherR", "umdx", `${branch.rootDropId}suffix`])(
    "rejects an unrelated explicit root response for %s",
    async (id) => {
      const { client, fetcher } = setup(branch);
      await expect(client.readStrategy({ id, branchId: branch.branchId }))
        .rejects.toThrow("Invalid resolved strategy response");
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { id: "" },
    { id: "root", branchId: " " },
    { id: "root", maxTokens: 99 },
    { id: "root", branchId: "branch", snapshotId: "wrong" },
  ])("rejects invalid requests before network access: %j", async (request) => {
    const { client, fetcher } = setup(branch);
    await expect(client.readStrategy(request)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  const metadataSetup = (ref: unknown = strategyRef, body: unknown = branch, status = 200) => {
    const result = setup(body, status);
    result.fetcher.mockResolvedValueOnce(new Response(JSON.stringify({
      content: "# Title only",
      metadata: { strategyRef: ref },
    }), { headers: { "Content-Type": "application/json", "X-Drop-Canonical-Id": branch.rootDropId } }));
    return result;
  };

  it.each([branch.rootDropId, "short"])("selects metadata with canonical root identity for %s", async (id) => {
    const { client, fetcher } = metadataSetup();
    const result = await client.readStrategy({ id, query: "next", top: 2, snapshotId: 7, maxTokens: 700, preview: false });
    expect(result).toMatchObject({ read: "branch", rootDropId: branch.rootDropId, branchId: branch.branchId, snapshotId: 7, data: branch });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[0][0])).toContain(`/api/get/${id}`);
    const url = new URL(String(fetcher.mock.calls[1][0]));
    expect(url.pathname).toBe(`/api/branches/${branch.rootDropId}/${branch.branchId}/resolved/query`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: "next", k: "2", snapshotId: "7", maxTokens: "700", preview: "false", snapshotterId: "nulledit.resolved-document" });
  });

  it("explicit empty branch B overrides metadata A without reading the root", async () => {
    const { client, fetcher } = setup({ ...branch, branchId: "B", items: [] });
    const result = await client.readStrategy({ id: branch.rootDropId, branchId: "B" });
    expect(result).toMatchObject({ read: "branch", branchId: "B", data: { items: [] } });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0][0])).toContain("/B/resolved/query");
  });

  it.each([null, {}, [], "branch", { ...strategyRef, kind: "root" },
    { ...strategyRef, rootDropId: "other" }, { ...strategyRef, rootDropId: "" },
    { ...strategyRef, rootDropId: ` ${branch.rootDropId}` },
    { ...strategyRef, branchId: "" }, { ...strategyRef, branchId: " " },
    { ...strategyRef, branchId: " B" }, { ...strategyRef, branchId: 42 },
  ])("rejects invalid metadata without a second fetch: %j", async (ref) => {
    const { client, fetcher } = metadataSetup(ref);
    await expect(client.readStrategy({ id: "short" })).rejects.toThrow("strategyRef");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([{ query: "next" }, { top: 1 }, { snapshotId: 7 }])("rejects branch-only options after checking a legacy root: %j", async (options) => {
    const { client, fetcher } = setup({ content: "# Legacy", metadata: { themeId: "system" } });
    await expect(client.readStrategy({ id: "root", ...options })).rejects.toThrow("require");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    { content: "# Legacy", metadata: { themeId: "system" } },
    { metadata: { strategyRef } },
    { schema: "nmdn.drop.v1", cipher: {}, metadata: { strategyRef } },
    { content: "not plaintext", schema: "nmdn.drop.v1", cipher: {}, metadata: { strategyRef: null } },
  ])("keeps legacy and non-plaintext metadata as root reads", async (body) => {
    const { client, fetcher } = setup(body);
    expect(await client.readStrategy({ id: "root" })).toMatchObject({ read: "root", data: body });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([403, 404, 500])("does not fall back after metadata branch HTTP %s", async (status) => {
    const { client, fetcher } = metadataSetup(strategyRef, { error: "unavailable" }, status);
    await expect(client.readStrategy({ id: "short" })).rejects.toThrow("unavailable");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([{ ...branch, rootDropId: "other" }, { ...branch, branchId: "B" }, { ...branch, snapshotId: 8 }])("checks metadata response identity: %j", async (body) => {
    const { client } = metadataSetup(strategyRef, body);
    await expect(client.readStrategy({ id: "short", snapshotId: 7 })).rejects.toThrow("Invalid resolved strategy response");
  });

  it("bounds implicit results without recursively following response metadata", async () => {
    const { client, fetcher } = metadataSetup(strategyRef, { ...branch, metadata: { strategyRef }, items: [{ text: "large".repeat(5000) }] });
    const result = await client.readStrategy({ id: "short", maxTokens: 100, format: "full" });
    expect(result).toMatchObject({ read: "branch", branchId: branch.branchId, snapshotId: 7, truncated: true });
    expect(JSON.stringify(result, null, 2).length).toBeLessThanOrEqual(400);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    { ...branch, branchId: "wrong-actor" },
    { ...branch, snapshotId: 0 },
    { ...branch, items: undefined },
  ])("rejects mismatched or malformed resolved responses", async (body) => {
    const { client, fetcher } = setup(body);
    await expect(
      client.readStrategy({
        id: branch.rootDropId,
        branchId: branch.branchId,
        snapshotId: 7,
      }),
    ).rejects.toThrow("Invalid resolved strategy response");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(["compact", "full"] as const)(
    "bounds escaped Unicode including %s formatting",
    async (format) => {
      const { client } = setup({
        ...branch,
        items: [{ text: '\ud83d\ude80"\\\n'.repeat(5000) }],
      });
      const result = await client.readStrategy({
        id: branch.rootDropId,
        branchId: branch.branchId,
        maxTokens: 100,
        format,
      });
      expect(result).toMatchObject({
        rootDropId: branch.rootDropId,
        branchId: branch.branchId,
        snapshotId: 7,
        truncated: true,
        partial: true,
      });
      expect(result.requery).toContain("query");
      expect(
        JSON.stringify(result, null, format === "full" ? 2 : 0).length,
      ).toBeLessThanOrEqual(400);
      expect(result.excerpt).not.toMatch(/[\uD800-\uDBFF]$/);
    },
  );

  it("bounds oversized roots and preserves server truncation", async () => {
    const root = await setup("large".repeat(2000), 200, false).client.readStrategy({
      id: "root",
    });
    expect(root).toMatchObject({ read: "root", partial: true, truncated: true });
    expect(JSON.stringify(root).length).toBeLessThanOrEqual(3200);
    const result = await setup({ ...branch, truncated: true }).client.readStrategy({
      id: branch.rootDropId,
      branchId: branch.branchId,
    });
    expect(result.truncated).toBe(true);
  });
});

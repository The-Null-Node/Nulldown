import { jest } from "@jest/globals";
import { createNulldownClient } from "./nulldown-client";

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
        headers: {
          "Content-Type": json ? "application/json" : "text/plain",
        },
      }),
    );
    return {
      fetcher,
      client: createNulldownClient({
        baseUrl: "http://local.test",
        fetch: fetcher,
      }),
    };
  };

  const metadataSetup = (
    ref: unknown = strategyRef,
    body: unknown = branch,
    status = 200,
  ) => {
    const result = setup(body, status);
    result.fetcher.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          content: "# Title only",
          metadata: { strategyRef: ref },
        }),
        {
          headers: {
            "Content-Type": "application/json",
            "X-Drop-Canonical-Id": branch.rootDropId,
          },
        },
      ),
    );
    return result;
  };

  it("labels a root without discovering a branch", async () => {
    const { client, fetcher } = setup("# Title only", 200, false);

    await expect(
      client.readStrategy({ id: branch.rootDropId }),
    ).resolves.toEqual({
      read: "root",
      rootDropId: branch.rootDropId,
      revision: null,
      partial: false,
      truncated: false,
      data: "# Title only",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("reads only an explicit branch and forwards query controls", async () => {
    const { client, fetcher } = setup(branch);

    await expect(
      client.readStrategy({
        id: branch.rootDropId,
        branchId: branch.branchId,
        query: "next task",
        top: 3,
        snapshotId: 7,
        preview: false,
        maxTokens: 800,
      }),
    ).resolves.toMatchObject({
      read: "branch",
      rootDropId: branch.rootDropId,
      branchId: branch.branchId,
      snapshotId: 7,
      data: branch,
    });

    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: "next task",
      k: "3",
      snapshotId: "7",
      snapshotterId: "nulledit.resolved-document",
      maxTokens: "800",
      preview: "false",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("follows a valid same-root metadata strategyRef", async () => {
    const { client, fetcher } = metadataSetup();

    await expect(
      client.readStrategy({
        id: "umdxfM",
        query: "next",
        snapshotId: 7,
      }),
    ).resolves.toMatchObject({
      read: "branch",
      rootDropId: branch.rootDropId,
      branchId: branch.branchId,
      snapshotId: 7,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[1][0])).toContain(
      `/api/branches/${branch.rootDropId}/${branch.branchId}/resolved/query`,
    );
  });

  it("lets an explicit branch override metadata without reading the root", async () => {
    const { client, fetcher } = setup({ ...branch, branchId: "B", items: [] });

    await expect(
      client.readStrategy({ id: branch.rootDropId, branchId: "B" }),
    ).resolves.toMatchObject({ read: "branch", branchId: "B" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0][0])).toContain("/B/resolved/query");
  });

  it.each([
    null,
    {},
    [],
    { ...strategyRef, kind: "root" },
    { ...strategyRef, rootDropId: "other" },
    { ...strategyRef, branchId: " " },
  ])("rejects invalid metadata without falling back: %j", async (ref) => {
    const { client, fetcher } = metadataSetup(ref);

    await expect(client.readStrategy({ id: "umdxfM" })).rejects.toThrow(
      "strategyRef",
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([403, 404, 500])(
    "does not fall back after metadata branch HTTP %s",
    async (status) => {
      const { client, fetcher } = metadataSetup(
        strategyRef,
        { error: "unavailable" },
        status,
      );

      await expect(client.readStrategy({ id: "umdxfM" })).rejects.toThrow(
        "unavailable",
      );
      expect(fetcher).toHaveBeenCalledTimes(2);
    },
  );

  it("bounds metadata-selected results while retaining identity", async () => {
    const { client, fetcher } = metadataSetup(strategyRef, {
      ...branch,
      metadata: { strategyRef },
      items: [{ text: "large".repeat(5000) }],
    });

    const result = await client.readStrategy({
      id: "umdxfM",
      maxTokens: 100,
      format: "full",
    });

    expect(result).toMatchObject({
      read: "branch",
      rootDropId: branch.rootDropId,
      branchId: branch.branchId,
      snapshotId: 7,
      partial: true,
      truncated: true,
    });
    expect(JSON.stringify(result, null, 2).length).toBeLessThanOrEqual(400);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    { ...branch, rootDropId: "other" },
    { ...branch, branchId: "other" },
    { ...branch, snapshotId: 8 },
    { ...branch, items: undefined },
  ])("rejects mismatched branch identity: %j", async (body) => {
    const { client } = metadataSetup(strategyRef, body);

    await expect(
      client.readStrategy({ id: "umdxfM", snapshotId: 7 }),
    ).rejects.toThrow("Invalid resolved strategy response");
  });
});

import {
  createCliDurabilityHarness,
  type CliProcessResult,
} from "../cli/test-harness";
import { createNulldownClient } from "./nulldown-client";

const jsonResult = <T>(result: CliProcessResult): T => {
  if (result.status !== 0 || result.signal !== null || result.stderr !== "") {
    throw new Error(`CLI failed: ${JSON.stringify(result)}`);
  }
  return JSON.parse(result.stdout) as T;
};

it("reads an explicit local branch without replacing the title-only root", async () => {
  const harness = await createCliDurabilityHarness();
  try {
    await harness.start();
    const title = "# Strategy Smoke Root\n";
    const sentinel = "STRATEGY_LOCAL_BRANCH_SENTINEL";
    const created = jsonResult<{ id: string }>(
      await harness.nd(["create", "-"], title),
    );
    const branch = jsonResult<{ branchId: string }>(
      await harness.nd(["branch", "resolve", created.id]),
    );
    // Account identity, not client identity, selects a branch in this harness.
    const otherClient = createNulldownClient({
      baseUrl: harness.baseUrl,
      accountId: "strategy-local-other-account",
      clientId: "strategy-local-b",
      token: "",
      diffAuthToken: null,
      diffWebhookSecret: null,
    });
    const branchB = await otherClient.resolveBranch(created.id) as { branchId: string };
    expect(branchB.branchId).not.toBe(branch.branchId);
    await otherClient.applyDiff({
      dropId: created.id,
      branchId: branchB.branchId,
      ops: [{ type: "delete", start: 0, end: title.length, text: title }],
    });
    const details = [
      "",
      "## Local Read Verification",
      "",
      `${sentinel}: query this explicit branch and retain snapshot provenance.`,
      "",
      "- [ ] Verify the root stays title-only.",
      "- [ ] Reject missing branches without fallback.",
      "",
    ].join("\n");
    const applied = jsonResult<{ accepted: number; snapshotId: number }>(
      await harness.nd([
        "diff",
        "apply",
        created.id,
        `--branch=${branch.branchId}`,
        "--event-id=strategy-local-smoke-edit",
        "--created-at=1700000000000",
        `--insert=${title.length}:${details}`,
      ]),
    );
    expect(applied).toMatchObject({ accepted: 1, snapshotId: 1 });

    const requests: Array<{ method: string; url: string }> = [];
    const client = createNulldownClient({
      baseUrl: harness.baseUrl,
      accountId: "cli-durability-account",
      clientId: "cli-durability-a",
      token: "",
      diffAuthToken: null,
      diffWebhookSecret: null,
      fetch: async (input, init) => {
        requests.push({ method: init?.method ?? "GET", url: String(input) });
        return fetch(input, { ...init, signal: AbortSignal.timeout(20_000) });
      },
    });
    const root = await client.readStrategy({ id: created.id });
    expect(root).toMatchObject({
      read: "root",
      rootDropId: created.id,
      partial: false,
      truncated: false,
      data: { content: title, metadata: { themeId: "system" } },
    });
    expect(root).not.toHaveProperty("branchId");
    expect(JSON.stringify(root)).not.toContain(sentinel);

    const target = {
      id: created.id,
      branchId: branch.branchId,
      snapshotId: applied.snapshotId,
      query: sentinel,
      top: 1,
    };
    const resolved = await client.readStrategy(target);
    expect(resolved).toMatchObject({
      read: "branch",
      rootDropId: created.id,
      branchId: branch.branchId,
      snapshotId: applied.snapshotId,
      partial: true,
      truncated: false,
      data: {
        snapshotterId: "nulledit.resolved-document",
        stale: false,
        items: [expect.objectContaining({ text: expect.stringContaining(sentinel) })],
      },
    });
    expect(JSON.stringify(resolved).length).toBeLessThanOrEqual(800 * 4);

    // This checks the backend's regeneration flag, not whether reads replay content.
    const repeated = await client.readStrategy(target);
    expect(repeated).toMatchObject({
      rootDropId: created.id,
      branchId: branch.branchId,
      snapshotId: applied.snapshotId,
      data: { heapGenerated: false, stale: false },
    });
    expect((repeated.data as { items: unknown[] }).items).toEqual(
      (resolved.data as { items: unknown[] }).items,
    );

    const beforeMissing = requests.length;
    await expect(
      client.readStrategy({
        ...target,
        branchId: "clone_account:00000000-0000-4000-8000-000000000000",
      }),
    ).rejects.toMatchObject({ name: "NulldownClientError", status: 404 });
    expect(requests.slice(beforeMissing)).toHaveLength(1);
    expect(requests[beforeMissing].url).toContain("/resolved/query?");
    expect(await client.readStrategy({ id: created.id })).toEqual(root);

    // Restart exercises persisted storage, not just in-process branch state.
    await harness.stop();
    await harness.start();
    const fresh = createNulldownClient({
      baseUrl: harness.baseUrl,
      accountId: "cli-durability-account",
      clientId: "strategy-local-fresh",
      token: "",
      diffAuthToken: null,
      diffWebhookSecret: null,
      fetch: async (input, init) => {
        requests.push({ method: init?.method ?? "GET", url: String(input) });
        return fetch(input, { ...init, signal: AbortSignal.timeout(20_000) });
      },
    });
    const beforeRestartedRead = requests.length;
    const restarted = await fresh.readStrategy({ ...target, query: sentinel });
    expect(restarted).toMatchObject({
      read: "branch", rootDropId: created.id, branchId: branch.branchId,
      snapshotId: applied.snapshotId,
      data: { items: expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining(sentinel) })]) },
    });
    expect(requests.slice(beforeRestartedRead)).toHaveLength(1);
    const raw = await fresh.getDrop(created.id);
    expect(raw.body).toEqual({ content: title, metadata: { themeId: "system" } });
    const beforeOverride = requests.length;
    const empty = await fresh.readStrategy({ id: created.id, branchId: branchB.branchId, query: sentinel });
    expect(empty).toMatchObject({ read: "branch", branchId: branchB.branchId, data: { items: [] } });
    expect(requests.slice(beforeOverride)).toHaveLength(1);
    expect(requests.every(({ method }) => method === "GET")).toBe(true);
    expect(requests.some(({ url }) => url.includes("/branches/resolve/"))).toBe(false);
  } finally {
    await harness.dispose();
  }
}, 120_000);

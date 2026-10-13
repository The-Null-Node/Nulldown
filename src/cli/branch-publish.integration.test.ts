import { jest } from "@jest/globals";
import {
  createCliDurabilityHarness,
  type CliProcessResult,
} from "./test-harness";

jest.setTimeout(120_000);
const json = <T>(result: CliProcessResult): T => {
  if (result.status !== 0)
    throw new Error(`${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout) as T;
};

it("publishes with real nd processes and replays the receipt after a local server restart", async () => {
  const harness = await createCliDurabilityHarness();
  try {
    await harness.start();
    const root = json<{ id: string }>(
      await harness.nd(
        [
          "create",
          "-",
          '--metadata={"ownerAccountId":"cli-durability-account"}',
        ],
        "Root before",
      ),
    );
    const initial = await fetch(`${harness.baseUrl}/api/get/${root.id}`);
    const revision = initial.headers.get("X-Drop-Revision")!;
    await initial.body?.cancel();
    const branch = json<{ branchId: string }>(
      await harness.nd(["branch", "resolve", root.id]),
    );
    expect(branch.branchId).toBe("owner");
    const diff = json<{ snapshotId: number }>(
      await harness.nd([
        "diff",
        "apply",
        root.id,
        "--branch=owner",
        "--insert=0:Published ",
      ]),
    );
    const args = [
      "branch",
      "publish",
      root.id,
      `--expected-snapshot=${diff.snapshotId}`,
      `--expected-revision=${revision}`,
      "--idempotency-key=local-smoke",
    ];
    const published = json<{ dropId: string; outcome: string }>(
      await harness.nd(args),
    );
    expect(published.dropId).toBe(root.id);
    expect(published.outcome).toBe("root-published");
    expect((await harness.nd(["get", root.id, "--raw"])).stdout).toContain(
      "Published Root before",
    );
    await harness.stop();
    await harness.start();
    expect(json(await harness.nd(args))).toEqual(published);
    const unknown = await harness.nd([
      "diff",
      "apply",
      root.id,
      "--branch=missing",
      "--insert=0:Wrong ",
    ]);
    expect(unknown.status).not.toBe(0);
    const replace = await harness.nd(
      ["update", root.id, "-"],
      "Wrong replacement",
    );
    expect(replace.status).not.toBe(0);
    expect((await harness.nd(["get", root.id, "--raw"])).stdout).toContain(
      "Published Root before",
    );
  } finally {
    await harness.dispose();
  }
});

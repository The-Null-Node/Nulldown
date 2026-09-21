import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyHostedCheckpointPlan,
  createHostedCheckpointPlan,
  type HostedCheckpointApi,
  type HostedCheckpointInputV1,
  type HostedCheckpointPlanV1,
  verifyHostedCheckpointPlan,
} from "../src/cli/hostedCheckpoint";
import type { DropDiffPollResponse } from "../shared/drop/diff";
import {
  createNulldownClient,
  DEFAULT_NULLDOWN_BASE_URL,
} from "../src/client/nulldown-client";

const option = (args: string[], name: string): string | null => {
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1] ?? null;
  const prefixed = args.find((value) => value.startsWith(`${name}=`));
  return prefixed?.slice(name.length + 1) ?? null;
};

const readJson = async <T>(path: string): Promise<T> =>
  JSON.parse(await readFile(path, "utf8")) as T;

const writeJsonAtomic = async (path: string, value: unknown): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
};

const createApi = (
  options: { baseUrl: string; token?: string | null; accountId?: string | null },
): HostedCheckpointApi => {
  const client = createNulldownClient({
    baseUrl: options.baseUrl,
    token: options.token ?? null,
    accountId: options.accountId ?? null,
    clientId: "hosted-checkpoint",
    diffAuthToken: null,
    diffWebhookSecret: null,
  });
  return {
    async getBranchContent(rootId, branchId) {
      return (await client.getBranchContent(rootId, branchId)) as Awaited<
        ReturnType<HostedCheckpointApi["getBranchContent"]>
      >;
    },
    async resolveBranch(rootId) {
      return (await client.resolveBranch(rootId)) as Awaited<
        ReturnType<HostedCheckpointApi["resolveBranch"]>
      >;
    },
    async pollDiffEvents(rootId, branchId, cursor = -1) {
      const response = await client.request<DropDiffPollResponse>(
        `/api/diff/${encodeURIComponent(rootId)}?branchId=${encodeURIComponent(branchId)}&cursor=${cursor}&limit=200`,
      );
      return response.data as DropDiffPollResponse;
    },
    async applyDiff(request) {
      return client.applyDiff(request);
    },
  };
};

function usage(): never {
  throw new Error(
    [
      "Usage:",
      "  bun run hosted:checkpoint -- plan --input <checkpoint.json> --out <plan.json> [--base <url>]",
      "  bun run hosted:checkpoint -- apply --plan <plan.json> [--out <plan.json>] [--base <url>]",
      "  bun run hosted:checkpoint -- verify --plan <plan.json> [--base <url>]",
      "",
      "The script checkpoints one selected legacy head. apply requires a current ND_TOKEN for plan.targetAccountId.",
    ].join("\n"),
  );
}

export const runHostedCheckpoint = async (
  args: string[],
): Promise<HostedCheckpointPlanV1 | void> => {
  const [command] = args;
  const baseUrl = (option(args, "--base") ?? process.env.ND_BASE_URL ?? DEFAULT_NULLDOWN_BASE_URL).replace(
    /\/$/,
    "",
  );
  if (command === "plan") {
    const inputPath = option(args, "--input");
    const outputPath = option(args, "--out");
    if (!inputPath || !outputPath) usage();
    const plan = await createHostedCheckpointPlan(
      createApi({ baseUrl }),
      await readJson<HostedCheckpointInputV1>(inputPath),
    );
    await writeJsonAtomic(outputPath, plan);
    return plan;
  }

  const planPath = option(args, "--plan");
  if (!planPath) usage();
  const plan = await readJson<HostedCheckpointPlanV1>(planPath);
  if (command === "verify") {
    await verifyHostedCheckpointPlan(createApi({ baseUrl }), plan);
    return;
  }
  if (command === "apply") {
    const completed = await applyHostedCheckpointPlan(
      createApi({
        baseUrl,
        token: process.env.ND_TOKEN ?? null,
        accountId: plan.targetAccountId,
      }),
      plan,
      { token: process.env.ND_TOKEN ?? null },
    );
    await writeJsonAtomic(option(args, "--out") ?? planPath, completed);
    return completed;
  }
  usage();
};

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  void runHostedCheckpoint(process.argv.slice(2))
    .then((result) => {
      if (result) {
        console.log(JSON.stringify(result, null, 2));
      }
    })
    .catch((error: unknown) => {
      console.error(
        `Hosted checkpoint failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = 1;
    });
}

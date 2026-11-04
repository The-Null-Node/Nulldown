import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { createNulldownClient } from "../../src/client/nulldown-client";
import type {
  DropBranchContentResponse,
  DropBranchResolveResponse,
} from "../../shared/drop/branch";
import type {
  DropDiffAppendResponse,
  DropDiffPollResponse,
} from "../../shared/drop/diff";
import { serializeAccountProof } from "../../functions/api/_lib/accounts/identity/proof";
import { canonicalizeAccountEncryptionRecipient } from "../../functions/api/_lib/accounts/identity/records";
import { isDiagnosticId } from "../../shared/observability/events";
import { createApplicationMcpClient } from "./application-mcp-client";

const STAGING_BASE =
  "https://nulldown-state-plane-api-staging.rsrishitsingh.workers.dev";
const SYNTHETIC_ROOT = "eycCOatkShltStgmw1v2z4u411a0b2bPub";
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const write = (path: string, value: unknown) =>
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
type Identity = {
  accountId: string;
  signingPublicJwk: JsonWebKey;
  signingPrivateJwk: JsonWebKey;
  encryptionKid: string;
  encryptionPublicJwk: JsonWebKey;
};
type QueryResult = {
  rootDropId: string;
  branchId: string;
  snapshotId: number;
  sourceContentHash: string;
  stale: boolean;
  nodes: unknown[];
};
type Checkpoint = {
  deployment: string;
  branchId: string;
  content: DropBranchContentResponse;
  query: QueryResult;
  poll: DropDiffPollResponse;
  memory: unknown;
  historical: QueryResult;
  initialSnapshot: number;
};

async function identity(): Promise<Identity> {
  const signing = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const encryption = await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  );
  const recipient = await canonicalizeAccountEncryptionRecipient({
    encryptionKid: `query-outbox-${randomUUID()}`,
    encryptionPublicJwk: await crypto.subtle.exportKey(
      "jwk",
      encryption.publicKey,
    ),
  });
  assert.ok(recipient);
  return {
    accountId: randomUUID(),
    signingPublicJwk: await crypto.subtle.exportKey("jwk", signing.publicKey),
    signingPrivateJwk: await crypto.subtle.exportKey("jwk", signing.privateKey),
    ...recipient,
  };
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "--help") {
    console.log(
      "run|verify-after-redeploy --base=<dedicated staging URL> --root=<existing synthetic public root> --private-dir=<outside checkout> --evidence=<fresh directory> --cli=<compiled binary> --deployment=<version>\nWrites only the fresh authenticated account clone. No root creation or owner-branch writes.",
    );
    return;
  }
  assert.ok(mode === "run" || mode === "verify-after-redeploy", "Invalid mode");
  const options = new Map<string, string>();
  for (const arg of args) {
    const match =
      /^--(base|root|private-dir|evidence|cli|deployment)=(.+)$/.exec(arg);
    assert.ok(match && !options.has(match[1]), "Invalid or duplicate argument");
    options.set(match[1], match[2]);
  }
  const required = (name: string) => {
    const value = options.get(name);
    assert.ok(value, `Missing ${name}`);
    return value;
  };
  const base = required("base"),
    rootId = required("root");
  assert.equal(
    base,
    STAGING_BASE,
    "Only the dedicated staging API is permitted",
  );
  assert.equal(
    rootId,
    SYNTHETIC_ROOT,
    "Only the previously accepted synthetic public root is permitted",
  );
  const repository = realpathSync(
    fileURLToPath(new URL("../..", import.meta.url)),
  );
  const canonicalNewPath = (path: string) =>
    join(
      realpathSync(dirname(resolve(path))),
      resolve(path).split(sep).at(-1)!,
    );
  const privateDir = canonicalNewPath(required("private-dir"));
  const evidence = canonicalNewPath(required("evidence"));
  assert.ok(
    privateDir !== repository && !privateDir.startsWith(repository + sep),
    "Private directory must be outside checkout",
  );
  assert.ok(
    privateDir !== evidence &&
      !privateDir.startsWith(evidence + sep) &&
      !evidence.startsWith(privateDir + sep),
  );
  assert.ok(!existsSync(evidence), "Evidence directory must be fresh");
  const cli = realpathSync(required("cli"));
  assert.ok(lstatSync(cli).isFile() && (lstatSync(cli).mode & 0o111) !== 0);
  const deployment = required("deployment");
  if (mode === "run") {
    assert.ok(!existsSync(privateDir), "Run identities are single-use");
    mkdirSync(privateDir, { mode: 0o700 });
  }
  assert.ok(
    lstatSync(privateDir).isDirectory() &&
      !lstatSync(privateDir).isSymbolicLink(),
  );
  assert.equal(lstatSync(privateDir).mode & 0o777, 0o700);
  mkdirSync(evidence, { mode: 0o700 });
  write(join(evidence, "source-pins.json"), {
    commit: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repository,
      encoding: "utf8",
    }).trim(),
    trackedDiffSha256: hash(
      execFileSync("git", ["diff", "--binary"], {
        cwd: repository,
        encoding: "utf8",
      }),
    ),
    scriptSha256: hash(readFileSync(fileURLToPath(import.meta.url), "utf8")),
    cliSha256: createHash("sha256").update(readFileSync(cli)).digest("hex"),
    deployment,
  });
  const journal = join(evidence, "requests.jsonl");
  writeFileSync(journal, "", { mode: 0o600, flag: "wx" });
  const checks: Array<{ name: string; passed: boolean; location?: string }> =
    [];
  let phase = "setup",
    requests = 0;
  const runId = `qo-${randomUUID()}`;
  const readPrivate = <T>(name: string): T => {
    const path = join(privateDir, name);
    assert.equal(lstatSync(path).mode & 0o777, 0o600);
    assert.ok(!lstatSync(path).isSymbolicLink());
    return JSON.parse(readFileSync(path, "utf8")) as T;
  };
  const nativeFetch = globalThis.fetch;
  const deadline = AbortSignal.timeout(240_000);
  const fetchImpl: typeof fetch = Object.assign(
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      assert.equal(url.origin, base);
      const operationId = randomUUID(),
        started = Date.now();
      const headers = new Headers(
        input instanceof Request ? input.headers : undefined,
      );
      new Headers(init?.headers).forEach((value, name) =>
        headers.set(name, value),
      );
      headers.set("x-operation-id", operationId);
      const row: Record<string, unknown> = {
        index: ++requests,
        phase,
        operationId,
        method: init?.method ?? "GET",
      };
      try {
        const response = await nativeFetch(input, {
          ...init,
          headers,
          redirect: "error",
          signal: AbortSignal.any([
            deadline,
            AbortSignal.timeout(20_000),
            ...(init?.signal ? [init.signal] : []),
          ]),
        });
        row.status = response.status;
        row.requestId = response.headers.get("x-request-id");
        assert.ok(isDiagnosticId(row.requestId));
        assert.equal(response.headers.get("x-operation-id"), operationId);
        return response;
      } finally {
        row.durationMs = Date.now() - started;
        appendFileSync(journal, JSON.stringify(row) + "\n");
      }
    },
    { preconnect: () => {} },
  );
  for (const key of [
    "ND_TOKEN",
    "ND_ACCOUNT_ID",
    "ND_AUTH_FILE",
    "ND_DIFF_AUTH_TOKEN",
    "DIFF_WEBHOOK_SECRET",
    "ND_BASE_URL",
    "ND_CLIENT_ID",
  ])
    delete process.env[key];
  const check = async (name: string, operation: () => Promise<void>) => {
    phase = name;
    await operation();
    checks.push({ name, passed: true });
  };
  let branchId: string | undefined;
  try {
    const actor =
      mode === "run"
        ? await identity()
        : readPrivate<Identity>("identity.json");
    if (mode === "run") write(join(privateDir, "identity.json"), actor);
    const checkpoint =
      mode === "run" ? undefined : readPrivate<Checkpoint>("checkpoint.json");
    if (checkpoint) assert.notEqual(checkpoint.deployment, deployment);
    const signedAt = Date.now();
    const login = async (account: Identity) => {
      const signing = await crypto.subtle.importKey(
        "jwk",
        account.signingPrivateJwk,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign"],
      );
      const signedAt = Date.now();
      const recipient = {
        encryptionKid: account.encryptionKid,
        encryptionPublicJwk: account.encryptionPublicJwk,
      };
      const signature = Buffer.from(
        await crypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          signing,
          new TextEncoder().encode(
            serializeAccountProof(account.accountId, signedAt, recipient),
          ),
        ),
      ).toString("base64url");
      const response = await fetchImpl(`${base}/api/auth/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accountId: account.accountId,
          signingPublicJwk: account.signingPublicJwk,
          ...recipient,
          signedAt,
          signature,
        }),
      });
      assert.equal(response.status, 200);
      const session = (await response.json()) as {
        token: string;
        accountId: string;
        expiresAt: number;
      };
      assert.equal(session.accountId, account.accountId);
      assert.ok(session.token && session.expiresAt > Date.now());
      return session;
    };
    const session = await login(actor);
    checks.push({ name: "real_signed_session", passed: true });
    const client = createNulldownClient({
      baseUrl: base,
      token: session.token,
      accountId: null,
      diffAuthToken: null,
      diffWebhookSecret: null,
      clientId: runId,
      requestTimeoutMs: 20_000,
      fetch: fetchImpl,
    });
    const resolved = (await client.resolveBranch(
      rootId,
    )) as DropBranchResolveResponse;
    branchId = resolved.branchId;
    assert.equal(branchId, `clone_account:${actor.accountId}`);
    assert.notEqual(branchId, "owner");
    if (checkpoint) assert.equal(branchId, checkpoint.branchId);
    const scope = { rootId, branchId };
    const content = () =>
      client.getBranchContent(
        rootId,
        branchId!,
      ) as Promise<DropBranchContentResponse>;
    const query = (snapshotId?: number) =>
      client.queryBranch({
        ...scope,
        query: "Synthetic",
        top: 10,
        snapshotId,
      }) as Promise<QueryResult>;
    const poll = async () =>
      (
        await client.request<DropDiffPollResponse>(
          `/api/diff/${rootId}?branchId=${encodeURIComponent(branchId!)}&cursor=-1&factCursor=-1&factLimit=100`,
        )
      ).data!;
    const memory = async () =>
      (
        (await client.queryMemory({
          ...scope,
          labels: ["query-outbox-acceptance"],
          includeRecords: true,
        })) as { records: unknown[] }
      ).records;
    const initial = await content();
    const initialSnapshot = checkpoint?.initialSnapshot ?? initial.snapshotId;
    const historical = await query(initialSnapshot);
    if (!checkpoint) {
      await check("fresh_clone_only_batch_and_retry", async () => {
        assert.equal(initial.snapshotId, 0);
        const batch = {
          version: 1,
          events: [0, 1].map((index) => ({
            dropId: rootId,
            eventId: `${runId}-${index}`,
            seq: 0,
            sourceClientId: runId,
            createdAt: signedAt,
            ops: [
              {
                type: "insert",
                start: 0,
                end: 0,
                text: `Synthetic query/outbox ${index}\n`,
              },
            ],
          })),
        };
        const path = `/api/diff/${rootId}?branchId=${encodeURIComponent(branchId!)}`;
        const send = () =>
          client.request<DropDiffAppendResponse>(path, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(batch),
          });
        const first = (await send()).data!,
          retry = (await send()).data!;
        assert.equal(first.accepted, 2);
        assert.equal(retry.accepted, 0);
        assert.equal(retry.deduplicated, 2);
        assert.equal(
          first.acknowledgements[0].snapshotId,
          first.acknowledgements[1].snapshotId,
        );
        assert.deepEqual(
          first.acknowledgements.map((item) => item.seq),
          [0, 1],
        );
      });
      await check("runtime_fact_retry", async () => {
        const head = await content();
        const fact = {
          version: 1 as const,
          kind: "ui.state.patch" as const,
          id: `${runId}-state`,
          callId: `${runId}-call`,
          createdAt: signedAt,
          source: {
            rootDropId: rootId,
            branchId: branchId!,
            snapshotId: head.snapshotId,
            sourceContentHash: `sha256:${createHash("sha256").update(`nulldown.source-content.v1\n${head.content}`).digest("base64url")}`,
            callId: `${runId}-call`,
          },
          patch: [{ op: "set" as const, path: ["synthetic"], value: true }],
        };
        const first = await client.storeNullplugState(fact),
          retry = await client.storeNullplugState(fact);
        assert.ok(first && retry);
        assert.deepEqual(first.fact, retry.fact);
      });
      await check("memory_upsert_and_delete", async () => {
        const recordId = `${runId}-memory`;
        await client.createMemoryFact({
          ...scope,
          recordId,
          text: "Synthetic initial",
          labels: ["query-outbox-acceptance"],
        });
        await client.createMemoryFact({
          ...scope,
          recordId,
          text: "Synthetic replacement",
          labels: ["query-outbox-acceptance"],
        });
        await client.deleteMemoryRecord({ ...scope, recordId });
      });
      await check("anonymous_write_denied", async () => {
        const denied = await fetchImpl(
          `${base}/api/diff/${rootId}?branchId=${encodeURIComponent(branchId!)}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ version: 1, events: [] }),
          },
        );
        assert.ok(denied.status === 401 || denied.status === 403);
        await denied.arrayBuffer();
      });
      await check("authenticated_outsider_write_denied", async () => {
        const outsider = await identity();
        write(join(privateDir, "outsider.json"), outsider);
        const outsiderSession = await login(outsider);
        const denied = await fetchImpl(
          `${base}/api/diff/${rootId}?branchId=${encodeURIComponent(branchId!)}`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              Authorization: `Bearer ${outsiderSession.token}`,
            },
            body: JSON.stringify({
              version: 1,
              events: [
                {
                  dropId: rootId,
                  eventId: `${runId}-denied`,
                  seq: 0,
                  sourceClientId: runId,
                  createdAt: signedAt,
                  ops: [
                    { type: "insert", start: 0, end: 0, text: "must reject" },
                  ],
                },
              ],
            }),
          },
        );
        assert.equal(denied.status, 403);
        await denied.arrayBuffer();
      });
    }
    let latest!: QueryResult;
    await check("exact_query_history_and_provenance", async () => {
      latest = await query();
      assert.equal(latest.branchId, branchId);
      assert.equal(latest.rootDropId, rootId);
      assert.equal(latest.stale, false);
      assert.equal(latest.snapshotId, (await content()).snapshotId);
      assert.ok(latest.nodes.length > 0);
      assert.deepEqual(await query(), latest);
      assert.deepEqual(await query(initialSnapshot), historical);
      const changed = (await client.queryBranch({
        ...scope,
        fromSeq: 0,
        toSeq: 1,
        changedOnly: true,
        includeEventMetadata: true,
        includeAncestors: true,
      })) as QueryResult;
      assert.equal(changed.sourceContentHash, latest.sourceContentHash);
      assert.ok(changed.nodes.length > 0);
      const timeline = await poll();
      assert.equal(timeline.events.length, 2);
      assert.equal(timeline.facts?.length, 1);
      assert.deepEqual(await memory(), []);
      if (checkpoint) {
        assert.deepEqual(latest, checkpoint.query);
        assert.deepEqual(historical, checkpoint.historical);
        assert.deepEqual(await content(), checkpoint.content);
        assert.deepEqual(await poll(), checkpoint.poll);
        assert.deepEqual(await memory(), checkpoint.memory);
      }
    });
    await check("mcp_query_parity", async () => {
      const mcp = await createApplicationMcpClient(
        base,
        session.token,
        fetchImpl,
      );
      try {
        assert.deepEqual(
          await mcp.call("branch_query", {
            ...scope,
            query: "Synthetic",
            top: 10,
            format: "full",
            maxTokens: 8000,
          }),
          latest,
        );
      } finally {
        await mcp.close();
      }
    });
    await check("compiled_cli_query_parity", async () => {
      const home = join(privateDir, `cli-${randomUUID()}`);
      mkdirSync(home, { mode: 0o700 });
      const startedAt = Date.now();
      const result = await new Promise<string>((resolveResult, reject) => {
        const child = spawn(
          cli,
          [
            "branch",
            "query",
            rootId,
            branchId!,
            "--query=Synthetic",
            "--top=10",
            `--base=${base}`,
            `--config-dir=${home}`,
            "--timeout-ms=20000",
            "--json",
          ],
          {
            env: {
              PATH: process.env.PATH,
              HOME: home,
              TMPDIR: home,
              ND_TOKEN: session.token,
              ND_CLIENT_ID: runId,
              CI: "true",
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let stdout = "",
          stderr = "";
        const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
          if (stdout.length + stderr.length > 1_000_000) child.kill("SIGKILL");
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
          if (stdout.length + stderr.length > 1_000_000) child.kill("SIGKILL");
        });
        child.once("error", () => {
          clearTimeout(timer);
          reject(Error("cli_spawn_failed"));
        });
        child.once("close", (code) => {
          clearTimeout(timer);
          if (
            code !== 0 ||
            stdout.includes(session.token) ||
            stderr.includes(session.token)
          )
            reject(Error("cli_failed"));
          else resolveResult(stdout);
        });
      });
      assert.deepEqual(JSON.parse(result), latest);
      write(join(evidence, "cli-window.json"), {
        startedAt,
        endedAt: Date.now(),
        clientId: runId,
        rootId,
        branchId,
      });
    });
    if (!checkpoint)
      write(join(privateDir, "checkpoint.json"), {
        deployment,
        branchId,
        content: await content(),
        query: latest,
        poll: await poll(),
        memory: await memory(),
        historical,
        initialSnapshot,
      } satisfies Checkpoint);
    write(join(evidence, "expected-delivery.json"), {
      rootId,
      branchId,
      generation: 1,
      counts: { document: 1, runtime_fact: 1, nullmem: 3 },
      snapshotId: latest.snapshotId,
      queryHash: hash(JSON.stringify(latest)),
    });
  } catch (error) {
    checks.push({
      name: phase,
      passed: false,
      location:
        error instanceof Error
          ? /hosted-query-outbox-acceptance\.ts:\d+:\d+/.exec(
              error.stack ?? "",
            )?.[0]
          : undefined,
    });
    process.exitCode = 1;
  } finally {
    const summary = {
      mode,
      base,
      rootId,
      branchId,
      deployment,
      requests,
      passed: checks.length > 0 && checks.every((check) => check.passed),
      checks,
      scriptSha256: hash(readFileSync(fileURLToPath(import.meta.url), "utf8")),
      coverage:
        "Fresh authenticated clone of a prior synthetic public root; query and mutation paths only. Root creation/provider authoring is not repeated. Parent verifies retained telemetry and archive/projection delivery.",
    };
    write(join(evidence, "summary.json"), summary);
    console.log(
      JSON.stringify({
        mode,
        passed: summary.passed,
        requests,
        checks: checks.length,
        evidence,
      }),
    );
  }
}

await main().catch(() => {
  console.error("Invalid setup; use --help. Existing files were preserved.");
  process.exitCode = 1;
});

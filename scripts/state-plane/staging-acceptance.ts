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
import { spawn } from "node:child_process";
import {
  createNulldownClient,
  type NulldownDiffApplyRequest,
} from "../../src/client/nulldown-client";
import { sealDropForAuthoring } from "../../shared/drop/authoring-crypto";
import { generateDropId } from "../../shared/drop/id";
import { BRANCH_STATE_ERRORS } from "../../shared/drop/branch-state";
import type { DropVisibility } from "../../shared/drop/types";
import type {
  DropBranchContentResponse,
  DropBranchResolveResponse,
  DropSnapshotListResponse,
} from "../../shared/drop/branch";
import type { DropDiffPollResponse } from "../../shared/drop/diff";
import { NULLDOWN_ACCOUNT_ID_HEADER } from "../../shared/drop/branch";
import { isDiagnosticId } from "../../shared/observability/events";
import { serializeAccountProof } from "../../functions/api/_lib/accounts/identity/proof";
import { canonicalizeAccountEncryptionRecipient } from "../../functions/api/_lib/accounts/identity/records";
import { createApplicationMcpClient } from "./application-mcp-client";

const help = `Hosted State Plane acceptance (Bun; explicit HTTPS staging origin only)

prepare --base=https://... --provider-public-jwk=/absolute/public.json
        --private-dir=/absolute/fresh-directory --evidence=/absolute/fresh-directory
run --base=https://... --provider-public-jwk=/absolute/public.json
    --private-dir=/absolute/prepared-directory --evidence=/absolute/fresh-directory
    --cli=/absolute/compiled-nulldown --deployment=<private-worker-version>
verify-after-redeploy [same run options, new evidence and deployment version]

All options use --name=value. Public key file schema:
{providerEncryptionPublicJwk: <RSA public JWK>, providerSigningPublicJwk: <EC public JWK>}
prepare generates client keys locally; run registers via POST /api/auth/session.
Private directories must be outside the repository and evidence (0700; files 0600).
run is single-use per prepared identity set, including failed runs. Prepare a new set
to retry. Verification requires a successful run and a different deployment version.
Parent owns deployment and Wrangler tail capture. Evidence contains bounded outcomes,
request/operation IDs and hashes; no tokens, client keys or response bodies.
No issuer secret, Cloudflare credential, seeding endpoint or OpenAuth login is needed.
Each HTTP call has a 20-second deadline; each CLI call has a 30-second deadline.
`;

type Identity = {
  accountId: string;
  signingPublicJwk: JsonWebKey;
  signingPrivateJwk: JsonWebKey;
  encryptionPublicJwk: JsonWebKey;
  encryptionPrivateJwk: JsonWebKey;
  encryptionKid: string;
};
type Prepared = {
  version: 1;
  runId: string;
  createdAt: number;
  base: string;
  providerHash: string;
  owner: Identity;
  outsider: Identity;
  publicRoot: string;
  privateRoot: string;
};
type Checkpoint = {
  deployment: string;
  content: DropBranchContentResponse;
  history: DropSnapshotListResponse;
  poll: DropDiffPollResponse;
  memory: unknown;
  retry: NulldownDiffApplyRequest;
  cloneBranch: string;
};
type MemoryResult = {
  records: { recordId: string; text?: string }[];
  procedureSteps?: unknown[];
};
const hash = (text: string | Uint8Array) =>
  createHash("sha256").update(text).digest("hex");
const inside = (path: string, parent: string) =>
  path === parent || path.startsWith(parent + sep);
const repository = realpathSync(
  fileURLToPath(new URL("../../", import.meta.url)),
);
const writeExclusive = (path: string, value: unknown) =>
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
const privateFile = (path: string) => {
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink());
  assert.equal(stat.mode & 0o777, 0o600);
  return readFileSync(path, "utf8");
};

async function freshIdentity(runId: string): Promise<Identity> {
  const [signing, encryption] = await Promise.all([
    crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]),
    crypto.subtle.generateKey(
      {
        name: "RSA-OAEP",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["encrypt", "decrypt"],
    ),
  ]);
  const recipient = await canonicalizeAccountEncryptionRecipient({
    encryptionKid: `staging-${runId}`,
    encryptionPublicJwk: await crypto.subtle.exportKey(
      "jwk",
      encryption.publicKey,
    ),
  });
  assert.ok(recipient);
  return {
    // Match the existing vault's random account identity convention.
    accountId: randomUUID(),
    signingPublicJwk: await crypto.subtle.exportKey("jwk", signing.publicKey),
    signingPrivateJwk: await crypto.subtle.exportKey("jwk", signing.privateKey),
    encryptionPrivateJwk: await crypto.subtle.exportKey(
      "jwk",
      encryption.privateKey,
    ),
    ...recipient,
  };
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "--help" || mode === "help") {
    console.log(help);
    return;
  }
  assert.ok(["prepare", "run", "verify-after-redeploy"].includes(mode));
  const options = new Map<string, string>();
  const allowed = new Set([
    "base",
    "provider-public-jwk",
    "private-dir",
    "evidence",
    "cli",
    "deployment",
  ]);
  for (const argument of args) {
    const match = /^--([a-z-]+)=(.+)$/.exec(argument);
    assert.ok(match && allowed.has(match[1]) && !options.has(match[1]));
    options.set(match[1], match[2]);
  }
  const required = (key: string) => {
    const value = options.get(key);
    assert.ok(value, `Missing --${key}`);
    return value;
  };
  const url = new URL(required("base"));
  assert.ok(url.protocol === "https:" && !url.username && !url.password);
  assert.ok(url.pathname === "/" && !url.search && !url.hash);
  assert.ok(
    url.hostname.includes("staging"),
    "Explicit staging hostname required",
  );
  const base = url.origin;
  const privateDir = resolve(required("private-dir"));
  const evidence = resolve(required("evidence"));
  // Resolve existing parents before creating directories so symlinks cannot bypass isolation.
  assert.equal(realpathSync(dirname(privateDir)), dirname(privateDir));
  assert.equal(realpathSync(dirname(evidence)), dirname(evidence));
  assert.ok(!inside(privateDir, repository));
  assert.ok(!inside(privateDir, evidence) && !inside(evidence, privateDir));
  mkdirSync(evidence, { mode: 0o700 });
  const checks: {
    name: string;
    passed: boolean;
    failure?: string;
    location?: string;
  }[] = [];
  let phase = "setup";
  let requests = 0;
  const journal = join(evidence, "requests.jsonl");
  writeFileSync(journal, "", { flag: "wx", mode: 0o600 });
  const safeFailure = (error: unknown) => {
    if (error instanceof assert.AssertionError) return "assertion_failed";
    if (error instanceof Error && error.message === "CLIENT_ACK_DISCARDED")
      return "client_ack_discarded";
    return "operation_failed";
  };
  const failureDetails = (error: unknown) => ({
    failure: safeFailure(error),
    location:
      error instanceof Error
        ? /staging-acceptance\.ts:\d+:\d+/.exec(error.stack ?? "")?.[0]
        : undefined,
  });
  const run = async (name: string, operation: () => Promise<void>) => {
    phase = name;
    try {
      await operation();
      checks.push({ name, passed: true });
    } catch (error) {
      checks.push({ name, passed: false, ...failureDetails(error) });
    }
    appendFileSync(
      join(evidence, "checks.jsonl"),
      JSON.stringify(checks.at(-1)) + "\n",
      { mode: 0o600 },
    );
  };
  let state: Prepared | undefined;
  try {
    const publicKeys = JSON.parse(
      readFileSync(required("provider-public-jwk"), "utf8"),
    ) as {
      providerEncryptionPublicJwk: JsonWebKey & { kid?: string };
      providerSigningPublicJwk: JsonWebKey;
    };
    assert.deepEqual(Object.keys(publicKeys).sort(), [
      "providerEncryptionPublicJwk",
      "providerSigningPublicJwk",
    ]);
    for (const key of Object.values(publicKeys)) {
      assert.ok(
        key &&
          !["d", "p", "q", "dp", "dq", "qi", "k"].some((field) => field in key),
      );
    }
    const publicJwk = publicKeys.providerEncryptionPublicJwk;
    assert.equal(publicJwk.kty, "RSA");
    const providerKey = await crypto.subtle.importKey(
      "jwk",
      publicJwk,
      { name: "RSA-OAEP", hash: "SHA-256" },
      false,
      ["encrypt"],
    );
    const providerHash = hash(
      JSON.stringify({
        kty: publicJwk.kty,
        n: publicJwk.n,
        e: publicJwk.e,
        kid: publicJwk.kid,
      }),
    );
    if (mode === "prepare") {
      mkdirSync(privateDir, { mode: 0o700 });
      const runId = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
      state = {
        version: 1,
        runId,
        createdAt: Date.now(),
        base,
        providerHash,
        owner: await freshIdentity(runId),
        outsider: await freshIdentity(runId),
        // Alias allocation uses the first six characters; timestamp-first IDs collide.
        publicRoot: `${generateDropId()}Stg${runId.replaceAll("-", "")}Pub`,
        privateRoot: `${generateDropId()}Stg${runId.replaceAll("-", "")}Priv`,
      };
      writeExclusive(join(privateDir, "identity.json"), state);
      checks.push({ name: "private_identity_prepared", passed: true });
      return;
    }
    assert.equal(realpathSync(privateDir), privateDir);
    assert.equal(lstatSync(privateDir).mode & 0o777, 0o700);
    state = JSON.parse(
      privateFile(join(privateDir, "identity.json")),
    ) as Prepared;
    assert.equal(state.version, 1);
    assert.equal(state.base, base);
    assert.equal(state.providerHash, providerHash);
    const prepared = state;
    const deployment = required("deployment");
    assert.ok(/^[A-Za-z0-9._:-]{1,120}$/.test(deployment));
    const cli = realpathSync(required("cli"));
    assert.ok(lstatSync(cli).isFile() && (lstatSync(cli).mode & 0o111) !== 0);
    const checkpointPath = join(privateDir, "checkpoint.json");
    const checkpoint: Checkpoint | undefined =
      mode === "verify-after-redeploy"
        ? (JSON.parse(privateFile(checkpointPath)) as Checkpoint)
        : undefined;
    if (checkpoint) assert.notEqual(checkpoint.deployment, deployment);
    else {
      assert.ok(!existsSync(checkpointPath));
      writeExclusive(join(privateDir, "run-started.json"), {
        deployment,
        timestamp: Date.now(),
      });
    }
    writeExclusive(join(evidence, "invocation.json"), {
      mode,
      runId: prepared.runId,
      base,
      deployment,
      previousDeployment: checkpoint?.deployment,
      providerHash,
      cliHash: hash(readFileSync(cli)),
      driverHash: hash(readFileSync(fileURLToPath(import.meta.url), "utf8")),
      bunVersion: Bun.version,
      telemetry:
        "Parent-owned Wrangler tails; correlate response requestId and operationId",
    });
    // SDK calls pass explicit credentials; MCP also consults process environment.
    // This standalone process must not inherit production credentials or diff secrets.
    for (const key of [
      "ND_TOKEN",
      "ND_ACCOUNT_ID",
      "ND_DIFF_AUTH_TOKEN",
      "DIFF_WEBHOOK_SECRET",
      "ND_BASE_URL",
      "ND_CLIENT_ID",
    ])
      delete process.env[key];
    const nativeFetch = globalThis.fetch;
    const suiteDeadline = AbortSignal.timeout(180_000);
    let discardNext = false;
    let operationId: string | undefined;
    const fetchImpl: typeof fetch = Object.assign(
      async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        const target = new URL(
          input instanceof Request ? input.url : String(input),
        );
        assert.equal(target.origin, base);
        const headers = new Headers(
          input instanceof Request ? input.headers : undefined,
        );
        new Headers(init?.headers).forEach((value, name) =>
          headers.set(name, value),
        );
        const sentOperationId = operationId ?? randomUUID();
        headers.set("x-operation-id", sentOperationId);
        const started = performance.now();
        const row: Record<string, unknown> = {
          index: ++requests,
          phase,
          operationId: sentOperationId,
          method:
            init?.method ?? (input instanceof Request ? input.method : "GET"),
          surface: target.pathname.includes("/memory/")
            ? "memory"
            : target.pathname.split("/")[2],
        };
        try {
          const response = await nativeFetch(input, {
            ...init,
            headers,
            redirect: "error",
            signal: AbortSignal.any([
              suiteDeadline,
              AbortSignal.timeout(20_000),
              ...(init?.signal ? [init.signal] : []),
            ]),
          });
          row.status = response.status;
          row.outcome =
            response.status >= 500
              ? "unavailable"
              : response.status >= 400
                ? "failure"
                : "success";
          const requestId = response.headers.get("x-request-id");
          const returnedOperationId = response.headers.get("x-operation-id");
          row.requestId = isDiagnosticId(requestId) ? requestId : null;
          row.operationId = isDiagnosticId(returnedOperationId)
            ? returnedOperationId
            : null;
          const reason = response.headers.get("x-diagnostic-reason");
          const reasons = new Set([
            ...Object.keys(BRANCH_STATE_ERRORS),
            "completed",
            "capability_unsupported",
            "account_proof_rejected",
            "account_auth_required",
            "forbidden",
            "not_found",
            "method_not_allowed",
            "conflict",
            "state_unavailable",
            "invalid_request",
            "staging_configuration_unavailable",
            "invalid_route_parameter",
          ]);
          row.reason = reason && reasons.has(reason) ? reason : "unclassified";
          assert.notEqual(row.reason, "unclassified");
          assert.ok(isDiagnosticId(row.requestId));
          assert.equal(row.operationId, sentOperationId);
          if (discardNext) {
            discardNext = false;
            await response.arrayBuffer();
            row.clientOutcome = "ack_discarded";
            throw Error("CLIENT_ACK_DISCARDED");
          }
          return response;
        } catch (error) {
          row.clientFailure = safeFailure(error);
          throw error;
        } finally {
          row.durationMs = Math.round(performance.now() - started);
          // No URL query, headers, response bodies, keys, account IDs or credentials.
          appendFileSync(journal, JSON.stringify(row) + "\n");
        }
      },
      { preconnect: () => {} },
    );
    const signingKey = (identity: Identity) =>
      crypto.subtle.importKey(
        "jwk",
        identity.signingPrivateJwk,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign"],
      );
    const proof = async (
      identity: Identity,
      signedAt = Date.now(),
      signer = identity,
    ) => {
      const recipient = {
        encryptionKid: identity.encryptionKid,
        encryptionPublicJwk: identity.encryptionPublicJwk,
      };
      const signature = await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        await signingKey(signer),
        new TextEncoder().encode(
          serializeAccountProof(identity.accountId, signedAt, recipient),
        ),
      );
      return {
        accountId: identity.accountId,
        signingPublicJwk: signer.signingPublicJwk,
        ...recipient,
        signedAt,
        signature: Buffer.from(signature).toString("base64url"),
      };
    };
    const auth = (body: unknown) =>
      fetchImpl(`${base}/api/auth/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const login = async (identity: Identity) => {
      const response = await auth(await proof(identity));
      assert.equal(response.status, 200);
      const result = (await response.json()) as {
        token: string;
        accountId: string;
        expiresAt: number;
      };
      assert.equal(result.accountId, identity.accountId);
      assert.ok(result.token && result.expiresAt > Date.now());
      return result.token;
    };
    let ownerToken = "",
      outsiderToken = "";
    await run("proof_bad_signature", async () => {
      const response = await auth({
        ...(await proof(prepared.owner)),
        signature: "AA",
      });
      assert.equal(response.status, 401);
      await response.arrayBuffer();
    });
    await run("proof_stale", async () => {
      const response = await auth(
        await proof(prepared.owner, Date.now() - 600_000),
      );
      assert.equal(response.status, 401);
      await response.arrayBuffer();
    });
    await run("real_account_registration_or_relogin", async () => {
      ownerToken = await login(prepared.owner);
      outsiderToken = await login(prepared.outsider);
      ownerToken = await login(prepared.owner);
    });
    await run("registered_account_wrong_key", async () => {
      assert.ok(ownerToken);
      const response = await auth(
        await proof(prepared.owner, Date.now(), prepared.outsider),
      );
      assert.equal(response.status, 401);
      await response.arrayBuffer();
    });
    assert.ok(
      ownerToken && outsiderToken,
      "Authentication prerequisite failed",
    );
    const makeClient = (
      token: string | null,
      clientId: string,
      visibility?: DropVisibility,
    ) =>
      createNulldownClient({
        baseUrl: base,
        token,
        clientId: `${prepared.runId}-${clientId}`,
        accountId: null,
        diffAuthToken: null,
        diffWebhookSecret: null,
        requestTimeoutMs: 20_000,
        fetch: fetchImpl,
        envelopeProvider: visibility
          ? {
              seal: async ({ content, metadata }) =>
                sealDropForAuthoring({
                  payload: { content, metadata },
                  metadata,
                  visibility,
                  unlockPolicy: "provider-escrow",
                  accountEncryption: {
                    accountId: prepared.owner.accountId,
                    encryptionKid: prepared.owner.encryptionKid,
                    encryptionPublicJwk: prepared.owner.encryptionPublicJwk,
                    encryptionPublicKey: await crypto.subtle.importKey(
                      "jwk",
                      prepared.owner.encryptionPublicJwk,
                      { name: "RSA-OAEP", hash: "SHA-256" },
                      false,
                      ["encrypt"],
                    ),
                  },
                  delegateSigning: {
                    signingKid: `${prepared.runId}-signing`,
                    signingPublicJwk: prepared.owner.signingPublicJwk,
                    signingPrivateKey: await signingKey(prepared.owner),
                  },
                  providerEncryption: {
                    kid: publicJwk.kid ?? "staging-provider",
                    publicKey: providerKey,
                  },
                }),
            }
          : undefined,
      });
    const a = makeClient(ownerToken, "A"),
      b = makeClient(ownerToken, "B");
    const outsider = makeClient(outsiderToken, "outsider");
    const anonymous = makeClient(null, "anonymous");
    const rootId = prepared.publicRoot;
    const scope = { rootId, branchId: "owner" };
    const initial = `# Synthetic staging ${prepared.runId}\n`;
    const content = () =>
      a.getBranchContent(rootId, "owner") as Promise<DropBranchContentResponse>;
    const history = async () =>
      (
        await a.request<DropSnapshotListResponse>(
          `/api/branches/${rootId}/owner/snapshots`,
        )
      ).data!;
    const poll = async () =>
      (
        await a.request<DropDiffPollResponse>(
          `/api/diff/${rootId}?branchId=owner&cursor=-1&factCursor=-1&factLimit=100`,
        )
      ).data!;
    const memory = () =>
      a.queryMemory({
        ...scope,
        labels: [prepared.runId],
        limit: 100,
        includeRecords: true,
      });
    const authoritativeMemoryRecords = async () =>
      ((await memory()) as MemoryResult).records;
    const denial = async (
      path: string,
      token: string | null,
      status: number,
      headers: Record<string, string> = {},
    ) => {
      const response = await fetchImpl(base + path, {
        method: "POST",
        headers: {
          ...headers,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
      assert.equal(response.status, status);
      await response.arrayBuffer();
    };
    let retry = checkpoint?.retry;
    let cloneBranch = checkpoint?.cloneBranch ?? "";
    if (!checkpoint) {
      await run("signed_sdk_root_creation_and_owner_convergence", async () => {
        for (const [id, visibility] of [
          [rootId, "public"],
          [prepared.privateRoot, "private"],
        ] as const) {
          const result = (await makeClient(
            ownerToken,
            "author",
            visibility,
          ).createDrop({
            id,
            content: initial,
            metadata: { themeId: "system" },
          })) as { id: string };
          assert.equal(result.id, id);
          const first = (await a.resolveBranch(
            id,
          )) as DropBranchResolveResponse;
          const second = (await b.resolveBranch(
            id,
          )) as DropBranchResolveResponse;
          assert.equal(first.branchId, "owner");
          assert.equal(first.created, true);
          assert.equal(second.branchId, first.branchId);
          assert.equal(second.created, false);
          assert.equal(
            (
              (await a.getBranchContent(
                id,
                "owner",
              )) as DropBranchContentResponse
            ).content,
            initial,
          );
        }
      });
      await run("public_account_clone_convergence", async () => {
        const first = (await outsider.resolveBranch(
          rootId,
        )) as DropBranchResolveResponse;
        const second = (await makeClient(
          outsiderToken,
          "outsider-second",
        ).resolveBranch(rootId)) as DropBranchResolveResponse;
        assert.equal(first.created, true);
        assert.equal(second.created, false);
        assert.equal(first.branchId, second.branchId);
        assert.notEqual(first.branchId, "owner");
        cloneBranch = first.branchId;
      });
    }
    await run("private_auth_denials_and_no_insecure_header", async () => {
      const path = `/api/branches/resolve/${prepared.privateRoot}`;
      await denial(path, null, 401);
      await denial(path, "invalid", 401);
      await denial(path, outsiderToken, 404);
      await denial(path, null, 401, {
        [NULLDOWN_ACCOUNT_ID_HEADER]: prepared.owner.accountId,
      });
      assert.equal(
        (
          (await a.getBranchContent(
            prepared.privateRoot,
            "owner",
          )) as DropBranchContentResponse
        ).content,
        initial,
      );
      for (const client of [anonymous, outsider]) {
        await assert.rejects(
          client.getBranchContent(prepared.privateRoot, "owner"),
          (error: unknown) =>
            typeof error === "object" &&
            error !== null &&
            "status" in error &&
            error.status === 404,
        );
      }
    });
    await run("public_read_and_owner_write_denials", async () => {
      assert.equal(
        (
          (await anonymous.getBranchContent(
            rootId,
            "owner",
          )) as DropBranchContentResponse
        ).rootDropId,
        rootId,
      );
      for (const [client, status] of [
        [anonymous, 401],
        [outsider, 403],
      ] as const) {
        await assert.rejects(
          client.createMemoryFact({
            ...scope,
            recordId: `${prepared.runId}-denied`,
            text: "synthetic",
          }),
          (error: unknown) =>
            typeof error === "object" &&
            error !== null &&
            "status" in error &&
            error.status === status,
        );
      }
    });
    await run("explicit_unsupported_mutation", async () => {
      // Root deletion is deliberately not provisioned by this isolated staging
      // gateway. Assert the application's authenticated capability response,
      // rather than treating a missing route or a credential denial as support.
      const response = await fetchImpl(`${base}/api/delete/${rootId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(response.status, 501);
      assert.equal(
        response.headers.get("x-diagnostic-reason"),
        "capability_unsupported",
      );
      await response.arrayBuffer();
    });
    await run("explicit_unsupported_resolved_query", async () => {
      const response = await fetchImpl(
        `${base}/api/branches/${rootId}/owner/resolved/query?query=synthetic`,
        { headers: { Authorization: `Bearer ${ownerToken}` } },
      );
      assert.equal(response.status, 501);
      assert.equal(
        response.headers.get("x-diagnostic-reason"),
        "capability_unsupported",
      );
      await response.arrayBuffer();
    });
    if (!checkpoint) {
      await run("diff_lost_ack_exact_retry", async () => {
        retry = {
          dropId: rootId,
          branchId: "owner",
          eventId: `${prepared.runId}-retry`,
          createdAt: prepared.createdAt,
          ops: [
            {
              type: "insert",
              start: initial.length,
              end: initial.length,
              text: "retry\n",
            },
          ],
          metadata: { followsSeq: -1 },
        };
        operationId = randomUUID();
        try {
          discardNext = true;
          await assert.rejects(a.applyDiff(retry));
          const receipt = await a.applyDiff(retry);
          assert.equal(receipt.accepted, 0);
          assert.equal(receipt.deduplicated, 1);
          assert.equal(receipt.acknowledgements[0].seq, 0);
          await assert.rejects(
            a.applyDiff({
              ...retry,
              ops: [
                { type: "insert", start: 0, end: 0, text: "must reject\n" },
              ],
            }),
            (error: unknown) =>
              typeof error === "object" &&
              error !== null &&
              "status" in error &&
              error.status === 409,
          );
          assert.equal((await content()).content, initial + "retry\n");
        } finally {
          discardNext = false;
          operationId = undefined;
        }
      });
      await run("two_client_concurrent_appends_and_history", async () => {
        const before = await content();
        const results = await Promise.allSettled(
          [a, b].map((client, index) =>
            client.applyDiff({
              dropId: rootId,
              branchId: "owner",
              eventId: `${prepared.runId}-concurrent-${index}`,
              createdAt: prepared.createdAt,
              ops: [{ type: "insert", start: 0, end: 0, text: `${index}\n` }],
            }),
          ),
        );
        const receipts = results.map((result) => {
          assert.equal(result.status, "fulfilled");
          return (
            result as PromiseFulfilledResult<
              Awaited<ReturnType<typeof a.applyDiff>>
            >
          ).value;
        });
        assert.deepEqual(
          receipts.map((receipt) => receipt.acknowledgements[0].seq).sort(),
          [1, 2],
        );
        const after = await content();
        assert.ok(
          [`0\n1\n${before.content}`, `1\n0\n${before.content}`].includes(
            after.content,
          ),
        );
        const snapshots = await history();
        assert.deepEqual(
          snapshots.snapshots.map((snapshot) => snapshot.snapshotId),
          [0, 1, 2, 3],
        );
        const zero = (
          await a.request<DropBranchContentResponse>(
            `/api/branches/${rootId}/owner/content?snapshotId=0`,
          )
        ).data!;
        assert.equal(zero.content, initial);
      });
      await run("runtime_fact_state_response_and_retry", async () => {
        const head = await content();
        const source = {
          rootDropId: rootId,
          branchId: "owner",
          snapshotId: head.snapshotId,
          sourceContentHash: `sha256:${createHash("sha256").update(`nulldown.source-content.v1\n${head.content}`).digest("base64url")}`,
          callId: `${prepared.runId}-call`,
        };
        const fact = {
          version: 1 as const,
          kind: "ui.state.patch" as const,
          id: `${prepared.runId}-state`,
          callId: source.callId,
          createdAt: prepared.createdAt,
          source,
          patch: [
            { op: "set" as const, path: ["synthetic"], value: prepared.runId },
          ],
        };
        const first = await a.storeNullplugState(fact);
        const duplicate = await b.storeNullplugState(fact);
        assert.ok(first && duplicate);
        assert.deepEqual(first.fact, duplicate.fact);
        await a.submitNullplugResponse({
          version: 1,
          kind: "ui.response",
          id: `${prepared.runId}-response`,
          primitiveId: "approval",
          createdAt: prepared.createdAt,
          source,
          data: { synthetic: true },
        });
        const result = await poll();
        assert.equal(result.facts?.length, 2);
        assert.deepEqual(
          result.facts.map((item) => item.seq),
          [0, 1],
        );
        assert.equal((await content()).content, head.content);
      });
      await run("nullmem_upsert_filter_procedure_and_delete", async () => {
        const fact = {
          ...scope,
          recordId: `${prepared.runId}-fact`,
          text: "first",
          labels: [prepared.runId],
        };
        await a.createMemoryFact(fact);
        await b.createMemoryFact({ ...fact, text: "updated" });
        await a.createMemoryFact({
          ...scope,
          recordId: `${prepared.runId}-public`,
          text: "public synthetic",
          labels: [prepared.runId, "public-memory"],
        });
        await a.createMemoryFact({
          ...scope,
          recordId: `${prepared.runId}-delete`,
          text: "delete synthetic",
          labels: [prepared.runId],
        });
        await a.deleteMemoryRecord({
          ...scope,
          recordId: `${prepared.runId}-delete`,
        });
        await a.createMemoryProcedure({
          ...scope,
          recordId: `${prepared.runId}-procedure`,
          goal: "Synthetic staging",
          summary: "Synthetic procedure",
          labels: [prepared.runId],
          steps: [
            {
              index: 0,
              kind: "note",
              name: "Verify",
              status: "success",
              description: "Synthetic",
            },
          ],
        });
        const result = (await memory()) as MemoryResult;
        assert.equal(result.records.length, 3);
        assert.equal(
          result.records.find((item) => item.recordId === fact.recordId)?.text,
          "updated",
        );
        const visible = (await anonymous.queryMemory({
          ...scope,
          labels: [prepared.runId],
          includeRecords: true,
        })) as MemoryResult;
        assert.deepEqual(
          visible.records.map((item) => item.recordId),
          [`${prepared.runId}-public`],
        );
        const steps = (await a.queryMemory({
          ...scope,
          procedureId: `${prepared.runId}-procedure`,
          afterStep: -1,
          stepLimit: 1,
        })) as MemoryResult;
        assert.equal(steps.procedureSteps?.length, 1);
      });
    } else {
      await run("redeploy_persistence_and_original_diff_receipt", async () => {
        assert.deepEqual(await content(), checkpoint.content);
        assert.deepEqual(await history(), checkpoint.history);
        assert.deepEqual(await poll(), checkpoint.poll);
        // Persisted records are authoritative. Exclude query metadata and any
        // derived freshness values from redeploy equality.
        assert.deepEqual(await authoritativeMemoryRecords(), checkpoint.memory);
        const receipt = await a.applyDiff(checkpoint.retry);
        assert.equal(receipt.deduplicated, 1);
        assert.equal(receipt.accepted, 0);
        assert.equal(receipt.acknowledgements[0].seq, 0);
        assert.deepEqual(await content(), checkpoint.content);
        assert.equal(
          ((await outsider.resolveBranch(rootId)) as DropBranchResolveResponse)
            .branchId,
          checkpoint.cloneBranch,
        );
      });
    }
    await run("real_mcp_protocol_round_trip", async () => {
      const mcp = await createApplicationMcpClient(base, ownerToken, fetchImpl);
      try {
        const tools = await mcp.list();
        assert.ok(tools.tools.some((tool) => tool.name === "memory_query"));
        if (!checkpoint) {
          await mcp.call("memory_fact", {
            ...scope,
            recordId: `${prepared.runId}-mcp`,
            text: "Synthetic MCP fact",
            labels: [prepared.runId],
          });
        }
        const result = (await mcp.call("memory_query", {
          ...scope,
          labels: [prepared.runId],
          includeRecords: true,
          format: "full",
          maxTokens: 8000,
        })) as MemoryResult;
        assert.deepEqual(
          result.records,
          ((await memory()) as MemoryResult).records,
        );
        const branch = (await mcp.call("branch_content", {
          ...scope,
          format: "full",
          maxTokens: 8000,
        })) as DropBranchContentResponse;
        assert.equal(branch.content, (await content()).content);
      } finally {
        await mcp.close();
      }
    });
    await run("compiled_cli_authenticated_content", async () => {
      const childHome = join(privateDir, `cli-${randomUUID()}`);
      mkdirSync(childHome, { mode: 0o700 });
      const expected = await content();
      const expectedHistory = await history();
      const startedAt = Date.now();
      const cliEnvironment = {
        PATH: process.env.PATH,
        HOME: childHome,
        TMPDIR: childHome,
        CI: "true",
        ND_TOKEN: ownerToken,
        ND_CLIENT_ID: `${prepared.runId}-cli`,
      };
      const runCli = (args: string[]) =>
        new Promise<{ code: number | null; stdout: string; stderr: string }>(
          (resolveResult, reject) => {
            const child = spawn(
              cli,
              [
                ...args,
                `--base=${base}`,
                `--config-dir=${childHome}`,
                "--timeout-ms=20000",
                "--json",
              ],
              { env: cliEnvironment, stdio: ["ignore", "pipe", "pipe"] },
            );
            let stdout = "";
            let stderr = "";
            let overflow = false;
            for (const [stream, output] of [
              [child.stdout, "stdout"],
              [child.stderr, "stderr"],
            ] as const) {
              stream.on("data", (chunk: Buffer) => {
                if (output === "stdout") stdout += chunk.toString();
                else stderr += chunk.toString();
                if (stdout.length + stderr.length > 1_000_000) {
                  overflow = true;
                  child.kill("SIGKILL");
                }
              });
            }
            const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
            child.once("error", (error) => {
              clearTimeout(timer);
              reject(error);
            });
            child.once("close", (code) => {
              clearTimeout(timer);
              if (overflow) reject(new Error("CLI output limit exceeded"));
              else resolveResult({ code, stdout, stderr });
            });
          },
        );
      try {
        const resolved = await runCli(["branch", "resolve", rootId]);
        assert.equal(resolved.code, 0);
        assert.ok(
          !resolved.stdout.includes(ownerToken) &&
            !resolved.stderr.includes(ownerToken),
        );
        assert.equal(
          (JSON.parse(resolved.stdout) as DropBranchResolveResponse).branchId,
          "owner",
        );

        const snapshots = await runCli([
          "branch",
          "snapshots",
          rootId,
          "owner",
        ]);
        assert.equal(snapshots.code, 0);
        assert.ok(
          !snapshots.stdout.includes(ownerToken) &&
            !snapshots.stderr.includes(ownerToken),
        );
        const cliHistory = JSON.parse(
          snapshots.stdout,
        ) as DropSnapshotListResponse;
        assert.deepEqual(
          cliHistory.snapshots.map((snapshot) => snapshot.snapshotId),
          expectedHistory.snapshots.map((snapshot) => snapshot.snapshotId),
        );

        const resultRun = await runCli(["branch", "content", rootId, "owner"]);
        assert.equal(resultRun.code, 0);
        assert.ok(
          !resultRun.stdout.includes(ownerToken) &&
            !resultRun.stderr.includes(ownerToken),
        );
        const result = JSON.parse(
          resultRun.stdout,
        ) as DropBranchContentResponse;
        assert.equal(result.content, expected.content);
        assert.equal(result.branchId, "owner");
      } finally {
        writeExclusive(join(evidence, "cli-window.json"), {
          startedAt,
          endedAt: Date.now(),
          rootId,
          branchId: "owner",
          clientId: `${prepared.runId}-cli`,
          correlation:
            "CLI does not expose response diagnostic IDs; parent tail supplies HTTP/RPC correlation for this isolated request window.",
        });
      }
    });
    if (checks.every((check) => check.passed)) {
      assert.ok(retry && cloneBranch);
      const durable = {
        deployment,
        content: await content(),
        history: await history(),
        poll: await poll(),
        memory: await authoritativeMemoryRecords(),
        retry,
        cloneBranch,
      } satisfies Checkpoint;
      writeExclusive(join(evidence, "durable-summary.json"), {
        snapshotId: durable.content.snapshotId,
        headEventSeq: durable.content.headEventSeq,
        snapshotCount: durable.history.snapshots.length,
        eventCount: durable.poll.events.length,
        runtimeFactCount: durable.poll.facts?.length,
        contentHash: hash(durable.content.content),
        historyHash: hash(JSON.stringify(durable.history)),
        pollHash: hash(JSON.stringify(durable.poll)),
        memoryHash: hash(JSON.stringify(durable.memory)),
      });
      if (!checkpoint) writeExclusive(checkpointPath, durable);
    }
  } catch (error) {
    checks.push({ name: phase, passed: false, ...failureDetails(error) });
  } finally {
    const summary = {
      version: 1,
      mode,
      runId: state?.runId,
      base,
      roots: state ? [state.publicRoot, state.privateRoot] : [],
      requests,
      passed: checks.length > 0 && checks.every((check) => check.passed),
      checks,
      coverage:
        "Hosted HTTP/SDK/MCP/CLI outcomes; parent retains RPC tails and deployed runtime configuration. Redeploy verification does not prove individual DO eviction.",
    };
    writeExclusive(join(evidence, "summary.json"), summary);
    console.log(
      JSON.stringify({
        mode,
        runId: state?.runId,
        passed: summary.passed,
        checks: checks.length,
        failed: checks
          .filter((check) => !check.passed)
          .map((check) => check.name),
        requests,
        evidence,
      }),
    );
    if (!summary.passed) process.exitCode = 1;
  }
}

await main().catch(() => {
  // Never print SDK/crypto errors: they may embed credential-bearing inputs.
  console.error(
    "staging-acceptance: configuration/preflight failed; use --help. Existing artifacts retained.",
  );
  process.exitCode = 1;
});

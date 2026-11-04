import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import type { BuildOptions, BuildResult } from "esbuild";
import type * as MiniflareModule from "miniflare";
import type {
  Miniflare as NativeMiniflare,
  V4MiniflareOptions,
} from "miniflare";
import { runNativeOutboxAcceptance } from "../../packages/nulldown-state-plane/test/outbox-native.test";

const root = realpathSync(
  resolve(dirname(new URL(import.meta.url).pathname), "../.."),
);
const evidenceArg = process.argv
  .find((part) => part.startsWith("--evidence="))
  ?.slice(11);
assert.ok(evidenceArg, "Use --evidence=/absolute/fresh-directory");
const requestedEvidence = resolve(evidenceArg);
const evidence = resolve(
  realpathSync(dirname(requestedEvidence)),
  requestedEvidence.split("/").at(-1)!,
);
assert.ok(
  !evidence.startsWith(root + "/"),
  "Evidence must be outside repository",
);
assert.ok(
  !existsSync(evidence),
  "Evidence path must be new; existing artifacts are never overwritten",
);
const require = createRequire(resolve(root, "package.json"));
const runtimeRequire = createRequire(
  resolve(root, "node_modules/wrangler/package.json"),
);
const hash = (input: string | Uint8Array) =>
  createHash("sha256").update(input).digest("hex");
const compatDate = "2026-09-02";

async function main() {
  mkdirSync(evidence, { mode: 0o700 });
  for (const path of [resolve(evidence, "tmp"), resolve(evidence, "home")])
    mkdirSync(path, { recursive: true, mode: 0o700 });
  const esbuild = require("esbuild") as {
    build(options: BuildOptions): Promise<BuildResult>;
  };
  const build = await esbuild.build({
    absWorkingDir: root,
    entryPoints: [
      "packages/nulldown-state-plane/test/outbox-native.fixture.ts",
    ],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    external: ["cloudflare:workers"],
    outfile: resolve(evidence, "outbox-worker.mjs"),
    metafile: true,
  });
  const inputs = Object.keys(build.metafile!.inputs).map((path) => {
    const source = realpathSync(resolve(root, path));
    assert.ok(source.startsWith(root + "/"), `Source escaped repo: ${source}`);
    return { path, sha256: hash(readFileSync(source)) };
  });
  const key = randomBytes(32);
  const archiveKey = key.toString("base64");
  const pins = {
    root,
    commit: require("child_process")
      .execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      })
      .trim(),
    compatibilityDate: compatDate,
    driverSha256: hash(readFileSync(new URL(import.meta.url))),
    fixtureBundleSha256: hash(
      readFileSync(resolve(evidence, "outbox-worker.mjs")),
    ),
    lockSha256: hash(readFileSync(resolve(root, "bun.lock"))),
    migrationSha256: hash(
      readFileSync(
        resolve(
          root,
          "packages/nulldown-state-plane/migrations/0001_outbox_projection.sql",
        ),
      ),
    ),
    workerConfigSha256: hash(
      readFileSync(
        resolve(root, "packages/nulldown-state-plane/wrangler.staging.jsonc"),
      ),
    ),
    inputs,
    archiveKeySha256: hash(key),
    dependencies: ["miniflare", "workerd", "wrangler", "esbuild"].map(
      (name) => {
        const path = runtimeRequire.resolve(name + "/package.json");
        const bytes = readFileSync(path);
        return {
          name,
          version: JSON.parse(bytes.toString()).version,
          packageSha256: hash(bytes),
        };
      },
    ),
  };
  writeFileSync(
    resolve(evidence, "source-pins.json"),
    JSON.stringify(pins, null, 2) + "\n",
    { mode: 0o600, flag: "wx" },
  );
  writeFileSync(resolve(evidence, "native-trace.ndjson"), "", {
    mode: 0o600,
    flag: "wx",
  });
  writeFileSync(resolve(evidence, "delivery-events.ndjson"), "", {
    mode: 0o600,
    flag: "wx",
  });
  const originalLog = console.log;
  console.log = (...values: unknown[]) => {
    for (const value of values) {
      if (
        typeof value !== "string" ||
        !value.startsWith('{"event":"state_plane.outbox.')
      )
        continue;
      try {
        const event = JSON.parse(value) as Record<string, unknown>;
        if (
          typeof event.event === "string" &&
          typeof event.outcome === "string" &&
          typeof event.reason === "string" &&
          typeof event.jobRef === "string" &&
          /^op1_[A-Za-z0-9_-]{20,80}$/.test(event.jobRef)
        )
          appendFileSync(
            resolve(evidence, "delivery-events.ndjson"),
            JSON.stringify({
              event: event.event,
              outcome: event.outcome,
              reason: event.reason,
              jobRef: event.jobRef,
            }) + "\n",
            { mode: 0o600 },
          );
      } catch {
        /* diagnostics must never interfere with delivery */
      }
    }
    originalLog(...values);
  };
  const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } =
    runtimeRequire("miniflare") as typeof MiniflareModule;
  const queueName = `native-outbox-${randomUUID()}`;
  const options: V4MiniflareOptions = {
    rootPath: root,
    modulesRoot: evidence,
    resourceTmpPath: resolve(evidence, "tmp"),
    resourcePersistencePath: resolve(evidence, "resources"),
    host: "127.0.0.1",
    port: 0,
    cf: false,
    telemetry: { enabled: false },
    log: new Log(LogLevel.ERROR),
    workers: [
      {
        name: "native-outbox",
        modules: [
          { type: "ESModule", path: resolve(evidence, "outbox-worker.mjs") },
        ],
        modulesRoot: evidence,
        compatibilityDate: compatDate,
        bindings: {
          STATE_PLANE_LOCAL_TEST: "1",
          ENVIRONMENT: "staging",
          STATE_PLANE_OUTBOX_ENABLED: "1",
          OUTBOX_ARCHIVE_KEY: archiveKey,
          OUTBOX_ARCHIVE_KEY_ID: `local-${randomUUID()}`,
        },
        durableObjects: {
          BRANCH_STATE: {
            className: "OutboxAcceptanceObject",
            useSQLite: true,
            unsafeUniqueKey: "native-outbox-acceptance-v1",
          },
        },
        r2Buckets: ["OUTBOX_ARCHIVE"],
        d1Databases: ["OUTBOX_DB"],
        queueProducers: { OUTBOX_QUEUE: { queueName } },
        queueConsumers: {
          [queueName]: { maxBatchSize: 10, maxBatchTimeout: 1, maxRetries: 2 },
        },
        outboundService() {
          throw Error("NATIVE_OUTBOX_NETWORK_DISABLED");
        },
      },
    ],
  };
  const mf: NativeMiniflare = new Miniflare(convertV4MiniflareOptions(options));
  let mfDisposed = false;
  const worker = await mf.getWorker("native-outbox");
  const request = async (action: string, query: unknown, value?: unknown) => {
    const started = Date.now();
    const controller = AbortSignal.timeout(15_000);
    const response = await worker.fetch("https://native.invalid/fixture", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, query, value }),
      signal: controller,
    });
    const body = await response.text();
    let result: unknown;
    try {
      result = body ? JSON.parse(body) : null;
    } catch {
      result = { malformedResponse: true, bodyLength: body.length };
    }
    const object =
      result && typeof result === "object"
        ? (result as Record<string, unknown>)
        : {};
    const errorRecord =
      object.error && typeof object.error === "object"
        ? (object.error as Record<string, unknown>)
        : {};
    writeFileSync(
      resolve(evidence, "native-trace.ndjson"),
      JSON.stringify({
        action,
        status: response.status,
        elapsedMs: Date.now() - started,
        responseBytes: Buffer.byteLength(body),
        responseHash: hash(body),
        deliveryStatus: Array.isArray(
          (object.state as { delivery?: unknown[] } | undefined)?.delivery,
        )
          ? (
              object.state as { delivery: { status: string; n: number }[] }
            ).delivery
              .map((row) => `${row.status}:${row.n}`)
              .join(",")
          : undefined,
        receiptCount:
          typeof object.receiptCount === "number"
            ? object.receiptCount
            : undefined,
        projectionDomains: Array.isArray(object.cursors)
          ? (object.cursors as { domain: string }[])
              .map((row) => row.domain)
              .join(",")
          : undefined,
        failureArmed:
          typeof object.projectionFailureArmed === "boolean"
            ? object.projectionFailureArmed
            : undefined,
        errorCode:
          typeof errorRecord.code === "string" &&
          /^[a-z0-9_.-]{1,80}$/.test(errorRecord.code)
            ? errorRecord.code
            : undefined,
        fixtureFailure:
          object.fixtureError === "FIXTURE_PROJECTION_FAILURE"
            ? "projection_failure_injected"
            : undefined,
        fixtureError:
          typeof object.fixtureError === "string" &&
          /^[a-z0-9_.-]{1,80}$/.test(object.fixtureError)
            ? object.fixtureError
            : undefined,
      }) + "\n",
      { flag: "a", mode: 0o600 },
    );
    assert.equal(response.status, 200, `${action} returned ${response.status}`);
    assert.ok(result !== null, `${action} returned an empty response`);
    return result;
  };
  try {
    await request(
      "initialize",
      {
        target: { rootDropId: "init", branchId: "init" },
        placement: { routingVersion: 1, generation: 0 },
      },
      {
        sql: readFileSync(
          resolve(
            root,
            "packages/nulldown-state-plane/migrations/0001_outbox_projection.sql",
          ),
          "utf8",
        ),
      },
    );
    const roots = (await runNativeOutboxAcceptance((command) =>
      request(command.action, command.query, command.value),
    )) as {
      target: { rootDropId: string; branchId: string };
      placement: { routingVersion: number; generation: number };
    }[];
    // A new Miniflare process/module graph exercises persistence recovery; all
    // prior native-state, queue, D1, and R2 artifacts remain under this run's evidence path.
    await mf.dispose();
    mfDisposed = true;
    const restarted = new Miniflare(convertV4MiniflareOptions(options));
    try {
      const afterRestart = await restarted.getWorker("native-outbox");
      for (const query of roots) {
        const response = await afterRestart.fetch(
          "https://native.invalid/fixture",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "inspect", query }),
            signal: AbortSignal.timeout(15_000),
          },
        );
        assert.equal(response.status, 200);
        const state = (await response.json()) as {
          state: { canonical: number };
          receiptCount: number;
          archiveCount: number;
        };
        assert.equal(state.state.canonical, state.receiptCount);
        assert.ok(state.receiptCount > 0);
        assert.ok(state.archiveCount >= roots.length);
      }
    } finally {
      await restarted.dispose();
    }
    for (const input of pins.inputs) {
      assert.equal(
        hash(readFileSync(resolve(root, input.path))),
        input.sha256,
        `Source changed during native acceptance: ${input.path}`,
      );
    }
    assert.equal(
      hash(readFileSync(new URL(import.meta.url))),
      pins.driverSha256,
      "Native driver changed during acceptance",
    );
    assert.equal(
      hash(
        readFileSync(
          resolve(
            root,
            "packages/nulldown-state-plane/migrations/0001_outbox_projection.sql",
          ),
        ),
      ),
      pins.migrationSha256,
      "Projection migration changed during acceptance",
    );
    writeFileSync(
      resolve(evidence, "summary.json"),
      JSON.stringify({ passed: true, pins, evidence }, null, 2) + "\n",
      { mode: 0o600, flag: "wx" },
    );
    console.log(
      JSON.stringify({
        passed: true,
        evidence,
        source: pins.commit,
        inputs: inputs.length,
      }),
    );
  } catch (error) {
    writeFileSync(
      resolve(evidence, "summary.json"),
      JSON.stringify(
        {
          passed: false,
          error:
            error instanceof assert.AssertionError
              ? "acceptance_assertion_failed"
              : "native_runtime_failed",
          pins,
          evidence,
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600, flag: "wx" },
    );
    throw error;
  } finally {
    key.fill(0);
    if (!mfDisposed) await mf.dispose();
    console.log = originalLog;
  }
}

await main().catch((error: unknown) => {
  console.error(
    "native outbox acceptance failed; inspect bounded evidence; no credentials or archive key are emitted",
  );
  console.error(
    error instanceof assert.AssertionError
      ? "acceptance assertion failed"
      : "native runtime failed",
  );
  process.exitCode = 1;
});

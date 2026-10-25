// Actual compiled authenticated Pages read/diff with native disposable D1/R2.
import { createRequire } from "node:module";
import { realpathSync, appendFileSync } from "node:fs";
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import assert from "node:assert/strict";
const root = resolve(import.meta.dirname, "../../..");
const require = createRequire(
  realpathSync("node_modules/wrangler/package.json"),
);
const {
  Miniflare,
  convertV4MiniflareOptions,
  Log,
  LogLevel,
} = require("miniflare");
const config = { vars: { LOG_LEVEL: "error" } };
const pagesCompatibility = (
  await readFile(resolve(root, "wrangler.toml"), "utf8")
).match(/compatibility_date\s*=\s*"([^"]+)"/)[1];
const collectorConfigFile = resolve(
  root,
  "packages/nulldown-telemetry/wrangler.jsonc",
);
const collectorConfig = require("typescript").parseConfigFileTextToJson(
  collectorConfigFile,
  await readFile(collectorConfigFile, "utf8"),
);
assert.equal(
  collectorConfig.error,
  undefined,
  "Invalid collector JSONC configuration",
);
const collectorCompatibility = collectorConfig.config.compatibility_date;
const hash = (v) =>
  createHash("sha256")
    .update(typeof v === "string" || Buffer.isBuffer(v) ? v : JSON.stringify(v))
    .digest("hex");
const modes = ["off", "summary", "detailed"];
const results = [],
  samples = [],
  exports = [];
let sequence = 0;
const protocol = JSON.parse(
  await readFile(resolve(root, "scripts/profiling/PROTOCOL.json"), "utf8"),
);
const benchmarking = process.argv.includes("--benchmark");
const diagnostic = process.argv.includes("--diagnostic");
assert.equal(
  JSON.parse(
    await readFile(resolve(root, ".profiling/build-control.json"), "utf8"),
  ).diagnostic,
  diagnostic,
  "Diagnostic control cannot be used as acceptance evidence",
);
const diagnosticLog = resolve(root, ".profiling/task-diagnostic.jsonl");
if (diagnostic)
  await writeFile(
    diagnosticLog,
    JSON.stringify({
      diagnostic: true,
      acceptance: false,
      deadlineMs: 500,
      allowanceMs: 150,
    }) + "\n",
  );
const diagnosticRows = [];
const recordDiagnostic = (value) => {
  if (diagnostic) diagnosticRows.push(value);
};
const sealName =
  process.argv.find((s) => s.startsWith("--seal="))?.slice(7) ??
  "premeasurement-001.json";
assert.match(sealName, /^premeasurement-[0-9]{3}\.json$/);
{
  const freeze = JSON.parse(
    await readFile(resolve(root, ".profiling", sealName), "utf8"),
  );
  const sealed = (
    await readFile(resolve(root, ".profiling", sealName + ".sha256"), "utf8")
  )
    .trim()
    .split(/\s+/)[0];
  assert.equal(
    hash(await readFile(resolve(root, ".profiling", sealName), "utf8")),
    sealed,
  );
  for (const [path, digest] of Object.entries(freeze.files))
    assert.equal(
      hash(await readFile(resolve(root, path))),
      digest,
      "Frozen measurement source changed: " + path,
    );
  for (const [path, digest] of Object.entries(freeze.rootLocks))
    assert.equal(
      hash(await readFile(resolve(path))),
      digest,
      "Root dependency lock changed",
    );
  assert.equal(
    hash(await readFile(resolve(root, "scripts/profiling/PROTOCOL.json"))),
    freeze.protocolSha256,
  );
  assert.ok(
    process.env.MINIFLARE_WORKERD_PATH,
    "Approved native runtime must be explicit",
  );
  assert.equal(
    hash(await readFile(process.env.MINIFLARE_WORKERD_PATH)),
    freeze.runtime.sha256,
    "Frozen native runtime changed",
  );
}
const safeHead = (b) => ({
  version: b.version,
  branchId: b.branchId,
  mode: b.mode,
  status: b.status,
  headSnapshotId: b.headSnapshotId,
  headEventSeq: b.headEventSeq,
  snapshotHeapVersion: b.snapshotHeapVersion,
  checkpointInterval: b.checkpointInterval,
});
async function harness(mode, failure = "none") {
  let mf,
    outbound = 0;
  const batches = new Map(),
    audits = new Map(),
    arrivals = new Map(),
    accepted = new Map(),
    legacyArrivals = new Map();
  mf = new Miniflare(
    convertV4MiniflareOptions({
      rootPath: root,
      modulesRoot: root,
      resourceTmpPath: resolve(
        root,
        `.profiling/auth-runtime-${mode}-${failure}`,
      ),
      cf: false,
      telemetry: { enabled: false },
      host: "127.0.0.1",
      port: 0,
      log: new Log(LogLevel.NONE),
      workers: [
        {
          name: "pages",
          modules: [
            {
              type: "ESModule",
              path: resolve(root, ".profiling/authenticated-entry.js"),
            },
          ],
          modulesRoot: root,
          compatibilityDate: pagesCompatibility,
          bindings: {
            ...config.vars,
            LOG_LEVEL: "error",
            ACCOUNT_AUTH_SECRET: randomBytes(32).toString("hex"),
            ALLOW_INSECURE_ACCOUNT_HEADER: "0",
            STAGING_TELEMETRY_ENABLED: "1",
            STAGING_TELEMETRY_ENVIRONMENT: "staging",
            STAGING_PROFILING_MODE: mode,
            STAGING_PROFILING_SAMPLE_PERMILLE: "1000",
            FIXTURE_DIAGNOSTIC: diagnostic ? "1" : "0",
          },
          r2Buckets: ["R2_BUCKET"],
          d1Databases: ["DB"],
          outboundService: () => {
            outbound++;
            throw Error("External request denied");
          },
          serviceBindings: {
            ASSETS: async () => new Response(null, { status: 404 }),
            FIXTURE_AUDIT: async (request) => {
              const audit = await request.json();
              audits.set(audit.traceId, audit);
              recordDiagnostic({
                mode,
                failure,
                event: "audit",
                ...audit,
                ops: undefined,
              });
              return new Response(null, { status: 204 });
            },
            TELEMETRY: async (request) => {
              const start = performance.now(),
                batch = await request.clone().json();
              recordDiagnostic({
                mode,
                failure,
                event: "collector-arrival",
                endpoint: new URL(request.url).pathname,
                at: Date.now(),
                traceId: Array.isArray(batch)
                  ? undefined
                  : batch.events.at(-1).traceId,
              });
              if (Array.isArray(batch)) {
                for (const record of batch)
                  legacyArrivals.set(
                    record.operationId,
                    (legacyArrivals.get(record.operationId) ?? 0) + 1,
                  );
                const response = await (
                  await mf.getWorker("collector")
                ).fetch(request);
                assert.equal(
                  response.status,
                  204,
                  "Legacy UUID completion compatibility",
                );
                recordDiagnostic({
                  mode,
                  failure,
                  event: "collector-accepted",
                  endpoint: "completion",
                  at: Date.now(),
                  status: response.status,
                });
                return response;
              }
              const trace = batch.events.at(-1).traceId;
              arrivals.set(trace, (arrivals.get(trace) ?? 0) + 1);
              batches.set(trace, batch);
              try {
                if (failure === "throw")
                  throw Error("synthetic transport failure");
                if (failure === "timeout") {
                  await new Promise((r) => setTimeout(r, 550));
                  return new Response(null, { status: 204 });
                }
                if (failure === "redirect")
                  return new Response(null, {
                    status: 302,
                    headers: { Location: "https://must-not-follow.invalid/" },
                  });
                if (failure === "non204")
                  return new Response(null, { status: 200 });
                const response = await (
                  await mf.getWorker("collector")
                ).fetch(request);
                assert.equal(
                  response.status,
                  204,
                  "Collector rejected actual-route evidence",
                );
                recordDiagnostic({
                  mode,
                  failure,
                  event: "collector-accepted",
                  endpoint: "phases",
                  traceId: trace,
                  at: Date.now(),
                  status: response.status,
                });
                accepted.set(trace, (accepted.get(trace) ?? 0) + 1);
                return response;
              } finally {
                exports.push({
                  mode,
                  failure,
                  traceId: trace,
                  ms: performance.now() - start,
                });
              }
            },
          },
        },
        {
          name: "collector",
          modules: [
            {
              type: "ESModule",
              path: resolve(
                root,
                ".profiling/collector-upload-final/worker.js",
              ),
            },
          ],
          modulesRoot: root,
          bindings: { ENVIRONMENT: "staging" },
          compatibilityDate: collectorCompatibility,
          compatibilityFlags: ["nodejs_compat"],
          outboundService: () => {
            outbound++;
            throw Error("External request denied");
          },
        },
      ],
    }),
  );
  await mkdir(resolve(root, `.profiling/auth-runtime-${mode}-${failure}`), {
    recursive: true,
  });
  const db = await mf.getD1Database("DB", "pages");
  const migrations = (await readdir(resolve(root, "migrations")))
    .filter((n) => n.endsWith(".sql"))
    .sort();
  for (const file of migrations) {
    const sql = (await readFile(resolve(root, "migrations", file), "utf8"))
      .replace(/--[^\n]*/g, "")
      .split("\n")
      .join(" ");
    await db.exec(sql);
  }
  const pages = await mf.getWorker("pages"),
    bucket = await mf.getR2Bucket("R2_BUCKET", "pages");
  const cookieProof = await (
    await pages.fetch("https://profiling.local.invalid/__fixture/middleware")
  ).json();
  assert.equal(cookieProof.status, 201);
  assert.equal(cookieProof.body, "kept");
  assert.equal(cookieProof.cookies.length, 2);
  assert.deepEqual(cookieProof.cookies, [
    "fixture-access=one; HttpOnly; Expires=Wed, 21 Oct 2037 07:28:00 GMT",
    "fixture-refresh=two; HttpOnly; Expires=Thu, 22 Oct 2037 07:28:00 GMT",
  ]);
  const rawCookies = await pages.fetch(
    "https://profiling.local.invalid/__fixture/middleware?raw=1",
  );
  assert.equal(rawCookies.status, 201);
  assert.equal(await rawCookies.text(), "kept");
  assert.deepEqual(
    rawCookies.headers.getSetCookie(),
    cookieProof.cookies,
    "Native cookie list survives response delivery, including Expires commas, with throwing waitUntil",
  );
  assert.equal(
    (
      await (
        await pages.fetch(
          "https://profiling.local.invalid/__fixture/middleware?reject=1",
        )
      ).json()
    ).applicationRejectionPreserved,
    true,
  );
  async function init(id) {
    const r = await pages.fetch(
      `https://local.invalid/__fixture/init?id=${id}`,
    );
    assert.equal(r.status, 200);
    return (await r.json()).token;
  }
  async function send(id, token, body, kind = "append") {
    const trace = (++sequence).toString(16).padStart(32, "0");
    const operationId = `${trace.slice(0, 8)}-${trace.slice(8, 12)}-${trace.slice(12, 16)}-${trace.slice(16, 20)}-${trace.slice(20)}`;
    const url =
      kind === "read"
        ? `https://profiling.local.invalid/api/branches/${id}/owner/content`
        : `https://profiling.local.invalid/api/diff/${id}?branchId=owner`;
    const at = performance.now();
    const r = await pages.fetch(url, {
      method: kind === "read" ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "x-operation-id": operationId,
        traceparent: `00-${trace}-1234567890abcdef-01`,
      },
      ...(kind === "read" ? {} : { body: JSON.stringify(body) }),
    });
    const headersMs = performance.now() - at,
      bytes = await r.arrayBuffer(),
      wallMs = performance.now() - at;
    let value;
    try {
      value = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      value = null;
    }
    recordDiagnostic({
      event: "canonical-response",
      mode,
      failure,
      traceId: trace,
      status: r.status,
      wallMs,
    });
    // Bounded drain is OUTSIDE measured response time; never part of application acknowledgement.
    for (
      let i = 0;
      i < 200 &&
      (!audits.has(trace) || (mode !== "off" && !batches.has(trace)));
      i++
    )
      await new Promise((r) => setTimeout(r, 5));
    const evidenceAudit = audits.get(trace);
    if (
      !evidenceAudit ||
      (mode !== "off" && !batches.has(trace)) ||
      evidenceAudit.tasks?.some(
        (t) =>
          ["profile-export", "legacy-export"].includes(t.kind) && t.ms > 650,
      )
    ) {
      await writeFile(
        resolve(root, ".profiling/failure-attribution.json"),
        JSON.stringify(
          {
            diagnostic,
            mode,
            failure,
            traceId: trace,
            status: r.status,
            wallMs,
            audit: evidenceAudit ? { ...evidenceAudit, ops: undefined } : null,
            batchArrivals: arrivals.get(trace) ?? 0,
            collectorAccepted: accepted.get(trace) ?? 0,
            legacyArrivals: legacyArrivals.get(operationId) ?? 0,
          },
          null,
          2,
        ) + "\n",
      );
      recordDiagnostic({
        event: "missing-evidence",
        mode,
        failure,
        traceId: trace,
        audit: audits.get(trace)
          ? { ...audits.get(trace), ops: undefined }
          : null,
        batchArrivals: arrivals.get(trace) ?? 0,
      });
      if (diagnostic)
        appendFileSync(
          diagnosticLog,
          diagnosticRows.map((r) => JSON.stringify(r)).join("\n") + "\n",
        );
      diagnosticRows.length = 0;
    }
    assert.ok(audits.has(trace), "Missing bounded local operation audit");
    if (mode !== "off")
      assert.ok(batches.has(trace), "Missing actual-route telemetry");
    const audit = audits.get(trace),
      batch = batches.get(trace);
    recordDiagnostic({
      event: "pre-assertion",
      mode,
      failure,
      traceId: trace,
      audit: audit ? { ...audit, ops: undefined } : null,
      batchArrivals: arrivals.get(trace) ?? 0,
      legacyArrivals: legacyArrivals.get(operationId) ?? 0,
    });
    if (diagnostic) {
      appendFileSync(
        diagnosticLog,
        diagnosticRows.map((r) => JSON.stringify(r)).join("\n") + "\n",
      );
      diagnosticRows.length = 0;
    }
    assert.equal(
      legacyArrivals.get(operationId),
      1,
      "Exactly one legacy middleware completion alongside profiling",
    );
    const counts = {};
    for (const op of audit.ops)
      counts[op.operation] = (counts[op.operation] ?? 0) + 1;
    if (batch) {
      const phases = new Map(batch.summary.phases.map((p) => [p.phase, p]));
      for (const name of [
        "r2.get",
        "r2.head",
        "r2.put",
        "r2.delete",
        "r2.list",
        "r2.body",
      ])
        assert.equal(
          phases.get(name)?.count ?? 0,
          counts[name] ?? 0,
          `Exact post-cap ${name} count`,
        );
      assert.equal(
        phases.get("sql.read")?.count ?? 0,
        (counts["sql.first"] ?? 0) +
          (counts["sql.all"] ?? 0) +
          (counts["sql.raw"] ?? 0),
      );
      assert.equal(
        phases.get("sql.write")?.count ?? 0,
        (counts["sql.run"] ?? 0) +
          (counts["sql.batch"] ?? 0) +
          (counts["sql.exec"] ?? 0),
      );
      assert.equal(arrivals.get(trace), 1, "No export retries");
    } else assert.equal(arrivals.size, 0);
    assert.ok(
      audit.tasks
        .filter((t) => ["profile-export", "legacy-export"].includes(t.kind))
        .every((t) => t.ms <= 650),
      "Telemetry export task exceeds500ms deadline plus150ms scheduling allowance: " +
        JSON.stringify({ traceId: trace, tasks: audit.tasks }),
    );
    assert.equal(
      audit.tasks.filter((t) => t.kind === "legacy-export").length,
      1,
    );
    assert.equal(
      audit.tasks.filter((t) => t.kind === "profile-export").length,
      mode === "off" ? 0 : 1,
    );
    assert.equal(
      accepted.get(trace) ?? 0,
      mode !== "off" && failure === "none" ? 1 : 0,
      "Arrival is not acceptance; failure/timeout cases must report explicit loss",
    );
    return {
      status: r.status,
      value,
      traceId: trace,
      headersMs,
      wallMs,
      workerWallMs: audit.canonicalMs,
      backgroundMs: audit.backgroundMs,
      ops: audit.ops,
      operationHash: hash(audit.ops),
      counts,
      batch,
    };
  }
  const head = async (id) =>
    safeHead(
      await (await bucket.get(`__drop_branch__/${id}/owner.json`)).json(),
    );
  async function compatibility(batch) {
    const collector = await mf.getWorker("collector");
    const submit = (path, body) =>
      collector.fetch(`https://staging-telemetry.internal${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const wrongCount = structuredClone(batch);
    wrongCount.summary.phases[0].count++;
    assert.equal((await submit("/v1/phases", wrongCount)).status, 400);
    const outside = structuredClone(batch);
    outside.events[0].offsetMs = outside.events.at(-1).durationMs + 100;
    assert.equal((await submit("/v1/phases", outside)).status, 400);
    assert.equal(
      (
        await submit("/v1/phases", {
          version: 1,
          environment: "staging",
          events: batch.events,
        })
      ).status,
      204,
    );
    assert.equal(
      (await submit("/server", batch)).status,
      400,
      "Phase version1/2 objects are not legacy completion arrays",
    );
    const legacy = [
      {
        version: 1,
        event: "draft.created",
        operationId: "12345678-1234-1234-1234-123456789abc",
        timestamp: 1,
        outcome: "success",
      },
    ];
    assert.equal((await submit("/v1/phases", legacy)).status, 400);
    assert.equal((await submit("/browser", legacy)).status, 204);
    const browser = await pages.fetch(
      "https://profiling.local.invalid/__fixture/browser",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(legacy),
      },
    );
    assert.equal(browser.status, 202);
    for (let i = 0; i < 100 && !legacyArrivals.has(legacy[0].operationId); i++)
      await new Promise((r) => setTimeout(r, 5));
    assert.equal(legacyArrivals.get(legacy[0].operationId), 1);
    return {
      malformedRejected: 2,
      legacyPhaseV1Accepted: true,
      shapeConfusionRejected: true,
      browserAndServerCompatible: true,
      nativeCookieListPreserved: true,
    };
  }
  return {
    mf,
    init,
    send,
    head,
    migrations,
    compatibility,
    outbound: () => outbound,
    dispose: () => mf.dispose(),
  };
}
function envelope(id, count, prefix = "event", follows = -1) {
  return {
    version: 1,
    events: Array.from({ length: count }, (_, i) => ({
      eventId: `${prefix}-${String(i).padStart(3, "0")}`,
      seq: 0,
      dropId: id,
      sourceClientId: "fixture-writer",
      createdAt: 1000 + i,
      ops: [{ type: "insert", start: 0, end: 0, text: "x" }],
      metadata: { followsSeq: follows + i },
    })),
  };
}
const saved = (r) => ({
  status: r.status,
  receipt: r.value,
  traceId: r.traceId,
  operationHash: r.operationHash,
  counts: r.counts,
  ops: r.ops,
  detailRecords: r.batch?.events.length ?? 0,
  summary: r.batch?.summary,
  backgroundMs: r.backgroundMs,
});
const save = async (name, value) =>
  writeFile(
    resolve(root, ".profiling", name),
    JSON.stringify(value, null, 2) + "\n",
  );
let baseline;
try {
  for (const mode of modes) {
    const h = await harness(mode);
    try {
      const id = "RevTwo000001",
        token = await h.init(id),
        body = envelope(id, protocol.correctnessEvents);
      const missing = await h.send(id, "invalid", body);
      assert.equal(missing.status, 401);
      const initial = await h.head(id);
      const append = await h.send(id, token, body);
      assert.equal(append.status, 200);
      assert.equal(append.value.accepted, protocol.correctnessEvents);
      assert.equal(append.value.deduplicated, 0);
      const canonical = await h.head(id),
        read = await h.send(id, token, null, "read");
      assert.equal(read.status, 200);
      assert.equal(read.value.content, "x".repeat(protocol.correctnessEvents));
      const replay = await h.send(id, token, body);
      assert.equal(replay.status, 200);
      assert.equal(replay.value.accepted, 0);
      assert.equal(replay.value.deduplicated, protocol.correctnessEvents);
      assert.deepEqual(await h.head(id), canonical);
      const stale = await h.send(id, token, envelope(id, 1, "stale", -1));
      assert.equal(stale.status, 409);
      assert.equal(stale.value.code, "diff_predecessor_mismatch");
      assert.deepEqual(await h.head(id), canonical);
      assert.equal(canonical.headSnapshotId, initial.headSnapshotId + 1);
      assert.equal(canonical.headEventSeq, protocol.correctnessEvents - 1);
      if (mode === "detailed") {
        assert.equal(append.batch.events.length, 96);
        assert.ok(append.batch.summary.detailDropped > 0);
      }
      const comparison = {
        canonical,
        contentHash: hash(read.value.content),
        receipts: {
          append: append.value,
          replay: replay.value,
          stale: stale.value,
        },
        ops: {
          append: append.ops,
          replay: replay.ops,
          stale: stale.ops,
          read: read.ops,
        },
      };
      if (!baseline) baseline = comparison;
      else
        assert.deepEqual(
          comparison,
          baseline,
          "Mode changes canonical/receipt/ordered native operations",
        );
      if (mode === "detailed")
        await writeFile(
          resolve(root, ".profiling/captured-profile.json"),
          JSON.stringify(append.batch) + "\n",
        );
      const compatibility =
        mode === "detailed"
          ? await h.compatibility(append.batch)
          : { nativeCookieListPreserved: true };
      results.push({
        mode,
        negativeAuthStatus: missing.status,
        canonical,
        contentHash: comparison.contentHash,
        append: saved(append),
        replay: saved(replay),
        stale: saved(stale),
        read: { ...saved(read), receipt: undefined },
        compatibility,
        outbound: h.outbound(),
        nativeD1R2: true,
        migrations: h.migrations,
      });
      assert.equal(h.outbound(), 0);
    } finally {
      await h.dispose();
    }
  }
  for (const failure of ["non204", "redirect", "throw", "timeout"]) {
    const h = await harness("detailed", failure);
    try {
      const id = "RevTwo000001",
        token = await h.init(id),
        body = envelope(id, protocol.correctnessEvents);
      const append = await h.send(id, token, body);
      assert.equal(append.status, 200);
      const read = await h.send(id, token, null, "read");
      assert.equal(read.value.content, "x".repeat(protocol.correctnessEvents));
      assert.deepEqual(
        {
          canonical: await h.head(id),
          contentHash: hash(read.value.content),
          receipt: append.value,
          ops: append.ops,
        },
        {
          canonical: baseline.canonical,
          contentHash: baseline.contentHash,
          receipt: baseline.receipts.append,
          ops: baseline.ops.append,
        },
      );
      assert.equal(h.outbound(), 0);
      results.push({
        mode: "detailed",
        failure,
        canonical: await h.head(id),
        append: saved(append),
        outbound: 0,
      });
    } finally {
      await h.dispose();
    }
  }
  await save("authenticated-correctness.json", {
    passed: true,
    results,
    externalRequests: 0,
    realCompiledPages: true,
    auth: "ephemeral local HMAC account session, invalid bearer rejected401; insecure header disabled",
  });
  if (benchmarking) {
    const hs = await Promise.all(modes.map((mode) => harness(mode)));
    try {
      for (
        let round = 0;
        round < protocol.warmups + protocol.warmSamples + 1;
        round++
      ) {
        for (let step = 0; step < modes.length; step++) {
          const index = (round + step) % modes.length,
            mode = modes[index],
            h = hs[index];
          const id = `RevTwo${String(index * 100000 + round + 100).padStart(6, "0")}`,
            token = await h.init(id),
            body = envelope(id, protocol.benchmarkEvents);
          const label =
            round === 0
              ? "first-request-after-initialization"
              : round <= protocol.warmups
                ? "warmup"
                : "warm";
          const before = await h.head(id);
          assert.equal(
            before.headSnapshotId,
            0,
            "Benchmark branch must be fresh",
          );
          const append = await h.send(id, token, body);
          assert.equal(append.status, 200);
          assert.equal(
            append.value.accepted,
            protocol.benchmarkEvents,
            "Benchmark must measure an append, not a duplicate receipt",
          );
          assert.equal(append.value.deduplicated, 0);
          const read = await h.send(id, token, null, "read");
          assert.equal(read.status, 200);
          assert.equal(read.value.snapshotId, 1);
          assert.equal(read.value.headEventSeq, protocol.benchmarkEvents - 1);
          assert.equal(
            read.value.content,
            "x".repeat(protocol.benchmarkEvents),
          );
          for (const [workload, r] of [
            ["append", append],
            ["read", read],
          ])
            samples.push({
              mode,
              label,
              round,
              workload,
              events: protocol.benchmarkEvents,
              accepted: append.value.accepted,
              deduplicated: append.value.deduplicated,
              snapshotId: read.value.snapshotId,
              wallMs: r.wallMs,
              headersMs: r.headersMs,
              workerWallMs: r.workerWallMs,
              operationHash: r.operationHash,
              counts: r.counts,
            });
        }
      }
    } finally {
      await Promise.all(hs.map((h) => h.dispose()));
    }
    const stats = {};
    for (const mode of modes)
      for (const workload of ["append", "read"]) {
        const values = samples
          .filter(
            (s) =>
              s.mode === mode && s.workload === workload && s.label === "warm",
          )
          .map((s) => s.wallMs)
          .sort((a, b) => a - b);
        stats[`${mode}.${workload}`] = {
          count: values.length,
          p50Ms: values[Math.ceil(values.length * 0.5) - 1],
          p95Ms: values[Math.ceil(values.length * 0.95) - 1],
        };
      }
    const budget = {};
    for (const mode of ["summary", "detailed"])
      for (const workload of ["append", "read"]) {
        const off = stats[`off.${workload}`].p95Ms,
          delta = stats[`${mode}.${workload}`].p95Ms - off;
        const limit = protocol.wallBudgetMs[mode][workload];
        budget[`${mode}.${workload}`] = {
          addedP95Ms: delta,
          absoluteLimitMs: limit,
          relativeLimit: protocol.relativeLimit,
          relativeApplicable: off >= protocol.relativeBaselineMs,
          pass:
            delta <= limit &&
            (off < protocol.relativeBaselineMs ||
              delta / off <= protocol.relativeLimit),
        };
      }
    await writeFile(
      resolve(root, ".profiling/authenticated-samples.jsonl"),
      samples.map((s) => JSON.stringify(s)).join("\n") + "\n",
    );
    await save("authenticated-benchmark.json", {
      stats,
      budget,
      measurement:
        "host response wall includes native local D1/R2 and audit forwarding overhead; no export drain in measured response; Worker wall not CPU",
      protocolSha256: hash(
        await readFile(resolve(root, "scripts/profiling/PROTOCOL.json")),
      ),
      premeasurementSha256: hash(
        await readFile(resolve(root, ".profiling", sealName)),
      ),
      premeasurement: sealName,
      cpuMeasured: false,
      admissionClaim: false,
    });
  }
  await save("authenticated-export-samples.json", exports);
  console.log(
    JSON.stringify({
      passed: true,
      correctnessCases: results.length,
      benchmarking,
      samples: samples.length,
    }),
  );
} catch (error) {
  await save("authenticated-blocker.json", {
    name: error.name,
    message: error.message?.slice(0, 500),
    completedModes: results.map((r) => ({ mode: r.mode, failure: r.failure })),
    source: "local test failure; no remote action",
  });
  throw error;
}

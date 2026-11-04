/** @jest-environment node */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

it("accepts outbox delivery through native Worker, DO SQLite, Queue, R2 and D1", () => {
  const parent = mkdtempSync(join(tmpdir(), "native-outbox-acceptance-"));
  const evidence = join(parent, "run");
  const runner = resolve("scripts/state-plane/run-native-outbox-acceptance.ts");
  const result = spawnSync(
    "bun",
    ["--no-env-file", "run", runner, `--evidence=${evidence}`],
    {
      env: {
        PATH: process.env.PATH,
        HOME: parent,
        TMPDIR: parent,
        CI: "true",
        WRANGLER_SEND_METRICS: "false",
        WRANGLER_WRITE_LOGS: "false",
      },
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 1_000_000,
    },
  );
  assert.equal(
    result.status,
    0,
    `Native acceptance failed; evidence retained at ${evidence}\n${result.stderr.slice(-1000)}`,
  );
  assert.ok(existsSync(join(evidence, "summary.json")));
  assert.ok(existsSync(join(evidence, "source-pins.json")));
  assert.ok(existsSync(join(evidence, "native-trace.ndjson")));
  const summary = JSON.parse(
    readFileSync(join(evidence, "summary.json"), "utf8"),
  );
  expect(summary.passed).toBe(true);
  expect(summary.pins.inputs.length).toBeGreaterThan(20);
}, 125_000);

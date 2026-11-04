import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve("scripts/state-plane/hosted-query-outbox-acceptance.ts");
const base =
  "https://nulldown-state-plane-api-staging.rsrishitsingh.workers.dev";
const root = "eycCOatkShltStgmw1v2z4u411a0b2bPub";
const invoke = (args: string[]) =>
  spawnSync("bun", ["--no-env-file", "run", script, ...args], {
    encoding: "utf8",
    timeout: 15_000,
    env: { PATH: process.env.PATH, HOME: tmpdir() },
  });

describe("targeted hosted acceptance boundaries", () => {
  it("provides clone-only help without credentials or network access", () => {
    const result = invoke(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("fresh authenticated account clone");
  });

  it("rejects production origins before creating any files", () => {
    const directory = mkdtempSync(join(tmpdir(), "qo-guard-"));
    const evidence = join(directory, "evidence");
    const result = invoke([
      "run",
      "--base=https://nulldown.app",
      `--root=${root}`,
      `--evidence=${evidence}`,
      `--private-dir=${join(directory, "private")}`,
      `--cli=${process.execPath}`,
      "--deployment=guard-test",
    ]);
    expect(result.status).not.toBe(0);
    expect(existsSync(evidence)).toBe(false);
  });

  it("preserves existing evidence instead of overwriting a failed attempt", () => {
    const directory = mkdtempSync(join(tmpdir(), "qo-evidence-"));
    const evidence = join(directory, "evidence");
    mkdirSync(evidence);
    writeFileSync(join(evidence, "summary.json"), "preserved");
    const result = invoke([
      "run",
      `--base=${base}`,
      `--root=${root}`,
      `--evidence=${evidence}`,
      `--private-dir=${join(directory, "private")}`,
      `--cli=${process.execPath}`,
      "--deployment=guard-test",
    ]);
    expect(result.status).not.toBe(0);
    expect(readFileSync(join(evidence, "summary.json"), "utf8")).toBe(
      "preserved",
    );
    expect(existsSync(join(directory, "private"))).toBe(false);
  });
});

/** @jest-environment node */
import { generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve("scripts/state-plane/staging-acceptance.ts");
const roots: string[] = [];
const publicKeys = {
  providerEncryptionPublicJwk: generateKeyPairSync("rsa", {
    modulusLength: 2048,
  }).publicKey.export({ format: "jwk" }),
  providerSigningPublicJwk: generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  }).publicKey.export({ format: "jwk" }),
};

function fixture() {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "staging-driver-test-")),
  );
  roots.push(root);
  const keyPath = join(root, "public.json");
  writeFileSync(keyPath, JSON.stringify(publicKeys), { mode: 0o600 });
  const privateDir = join(root, "private");
  const invoke = (mode: string, evidence: string, extra: string[] = []) =>
    spawnSync(
      "bun",
      [
        "--no-env-file",
        "run",
        script,
        mode,
        "--base=https://staging.invalid",
        `--provider-public-jwk=${keyPath}`,
        `--private-dir=${privateDir}`,
        `--evidence=${join(root, evidence)}`,
        ...extra,
      ],
      {
        env: { PATH: process.env.PATH, HOME: root, TMPDIR: root },
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 100_000,
      },
    );
  return { root, keyPath, privateDir, invoke };
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("hosted acceptance local preparation boundary", () => {
  it("prints invocation help without keys or network configuration", () => {
    const result = spawnSync(
      "bun",
      ["--no-env-file", "run", script, "--help"],
      {
        encoding: "utf8",
        timeout: 15_000,
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("verify-after-redeploy");
    expect(result.stdout).toContain("providerEncryptionPublicJwk");
  });

  it("keeps identities private, evidence sanitized, and earlier runs immutable", () => {
    const f = fixture();
    const first = f.invoke("prepare", "evidence-1");
    expect(first.status).toBe(0);
    expect(first.stderr).toBe("");
    const identityPath = join(f.privateDir, "identity.json");
    const original = readFileSync(identityPath, "utf8");
    const identity = JSON.parse(original);
    expect(statSync(f.privateDir).mode & 0o777).toBe(0o700);
    expect(statSync(identityPath).mode & 0o777).toBe(0o600);
    const evidence = readdirSync(join(f.root, "evidence-1"))
      .map((file) => readFileSync(join(f.root, "evidence-1", file), "utf8"))
      .join("\n");
    for (const actor of [identity.owner, identity.outsider]) {
      for (const value of [
        actor.signingPrivateJwk.d,
        actor.encryptionPrivateJwk.d,
      ]) {
        expect(evidence + first.stdout + first.stderr).not.toContain(value);
      }
    }
    expect(
      JSON.parse(
        readFileSync(join(f.root, "evidence-1", "summary.json"), "utf8"),
      ).requests,
    ).toBe(0);
    const second = f.invoke("prepare", "evidence-2");
    expect(second.status).toBe(1);
    expect(readFileSync(identityPath, "utf8")).toBe(original);
    expect(
      JSON.parse(
        readFileSync(join(f.root, "evidence-2", "summary.json"), "utf8"),
      ).passed,
    ).toBe(false);
    const repeatedEvidence = f.invoke("prepare", "evidence-1");
    expect(repeatedEvidence.status).toBe(1);
    expect(
      readdirSync(join(f.root, "evidence-1"))
        .map((file) => readFileSync(join(f.root, "evidence-1", file), "utf8"))
        .join("\n"),
    ).toBe(evidence);
  }, 30_000);

  it("rejects accidentally supplied private provider keys without exposing them", () => {
    const f = fixture();
    const sentinel = "PRIVATE-PROVIDER-MATERIAL-MUST-NOT-APPEAR";
    writeFileSync(
      f.keyPath,
      JSON.stringify({
        ...publicKeys,
        providerEncryptionPublicJwk: {
          ...publicKeys.providerEncryptionPublicJwk,
          d: sentinel,
        },
      }),
    );
    const result = f.invoke("prepare", "evidence");
    expect(result.status).toBe(1);
    expect(existsSync(f.privateDir)).toBe(false);
    const retained = readFileSync(
      join(f.root, "evidence", "summary.json"),
      "utf8",
    );
    expect(retained + result.stdout + result.stderr).not.toContain(sentinel);
    expect(JSON.parse(retained).requests).toBe(0);
    expect(JSON.parse(retained).passed).toBe(false);
  });

  it("fails before hosted requests when saved client keys have permissive permissions", () => {
    const f = fixture();
    expect(f.invoke("prepare", "prepared").status).toBe(0);
    chmodSync(join(f.privateDir, "identity.json"), 0o644);
    const result = f.invoke("run", "rejected");
    expect(result.status).toBe(1);
    const retained = JSON.parse(
      readFileSync(join(f.root, "rejected", "summary.json"), "utf8"),
    );
    expect(retained.requests).toBe(0);
    expect(retained.passed).toBe(false);
    expect(existsSync(join(f.privateDir, "run-started.json"))).toBe(false);
  }, 30_000);
});

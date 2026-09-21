import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, type RunCliDependencies } from "./index";
import { generateCliDeviceKeyPair } from "./auth";
import { readCliCredential, writeCliCredential } from "./cli-credential";
import type { CliCredentialBundle } from "../../shared/auth/cliDevice";
import { encodeCliCredentialBundle } from "../../shared/auth/codecs/cli-device-v1";

const captureOutput = (): {
  stdout: string[];
  stderr: string[];
  dependencies: RunCliDependencies;
} => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    dependencies: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
  };
};

describe("runCli", () => {
  it.each(["near-expiry", "rejected"])("refreshes a %s bearer through injected transport without losing local authoring", async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), "nulldown-cli-refresh-"));
    const authFile = join(directory, "auth.json");
    const output = captureOutput();
    const keys = await generateCliDeviceKeyPair(true);
    const now = Date.now();
    const current: CliCredentialBundle = {
      baseUrl: "https://nulldown.test",
      userId: "user-1",
      accountId: "account-1",
      credentialId: "credential-1",
      refreshToken: "local-refresh-canary",
      accessToken: "local-access-canary",
      accessExpiresAt: now + (mode === "near-expiry" ? 1 : 60_000),
      credentialExpiresAt: now + 86_400_000,
      createdAt: now,
      authoring: {
        ...keys.authoring!,
        deviceDelegation: {
          accountId: "account-1",
          credentialId: "credential-1",
          delegateSigningPublicJwk: keys.authoring!.signingPublicJwk,
          encryptionKid: "enc-1",
          encryptionPublicJwk: keys.publicKey,
          issuedAt: now,
          expiresAt: now + 86_400_000,
          signature: { kid: "account-key", alg: "ECDSA_P256_SHA256", sig: "fixture-signature" },
        },
      },
    };
    const { authoring, ...bearer } = current;
    const replacement = { ...bearer, refreshToken: "rotated-refresh-canary", accessToken: "rotated-access-canary", accessExpiresAt: now + 120_000 };
    const paths: string[] = [];
    try {
      await writeCliCredential(authFile, current);
      const result = await runCli([
        "list", "--json", "--verbose", "--base=https://nulldown.test",
        `--config-dir=${directory}`, `--auth-file=${authFile}`,
      ], {
        ...output.dependencies,
        now: () => now,
        fetch: async (url, init) => {
          const path = new URL(String(url)).pathname;
          paths.push(path);
          const headers = new Headers(init?.headers);
          expect(headers.get("x-request-id")).toBeTruthy();
          expect(init?.signal).toBeDefined();
          if (path === "/api/auth/cli/refresh") {
            expect(headers.get("Authorization")).toBeNull();
            expect(JSON.parse(String(init?.body))).toEqual({ refreshToken: current.refreshToken });
            return Response.json(encodeCliCredentialBundle(replacement));
          }
          if (mode === "rejected" && paths.length === 1) {
            expect(headers.get("Authorization")).toBe(`Bearer ${current.accessToken}`);
            return Response.json({ error: "Expired", code: "expired" }, { status: 401 });
          }
          expect(headers.get("Authorization")).toBe(`Bearer ${replacement.accessToken}`);
          return Response.json({ drops: [] });
        },
      });
      expect(result).toEqual({ exitCode: 0 });
      expect(paths).toEqual(mode === "near-expiry"
        ? ["/api/auth/cli/refresh", "/api/list"]
        : ["/api/list", "/api/auth/cli/refresh", "/api/list"]);
      expect(await readCliCredential(authFile)).toEqual({ ...replacement, authoring });
      expect(output.stdout).toEqual([JSON.stringify({ drops: [] }, null, 2)]);
      expect(output.stderr.join("\n")).not.toContain("canary");
      expect(output.stderr.join("\n")).not.toContain(keys.authoring!.signingPrivateJwk.d);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns exit 1 and preserves JSON stderr", async () => {
    const output = captureOutput();

    const result = await runCli(
      ["unknown-command", "--json"],
      output.dependencies,
    );

    expect(result).toEqual({ exitCode: 1 });
    expect(output.stdout).toEqual([]);
    expect(output.stderr).toHaveLength(1);
    expect(JSON.parse(output.stderr[0]!)).toEqual({
      error: "Unknown command: unknown-command",
      code: "unknown_command",
    });
  });

  it.each(["not-a-number", "0.4", "2147483648"])(
    "returns a structured configuration error for timeout %s",
    async (timeout) => {
      const output = captureOutput();

      const result = await runCli(
        ["list", "--json", "--timeout-ms", timeout],
        output.dependencies,
      );

      expect(result).toEqual({ exitCode: 1 });
      expect(output.stdout).toEqual([]);
      expect(JSON.parse(output.stderr[0]!)).toEqual({
        error:
          "Request timeout must be an integer from 1 to 2147483647.",
        code: "invalid_request_timeout",
      });
    },
  );

  it("preserves config-file JSON mode when configuration is invalid", async () => {
    const output = captureOutput();
    const directory = await mkdtemp(join(tmpdir(), "nulldown-cli-config-"));
    const configPath = join(directory, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({ json: true, requestTimeoutMs: true }),
      "utf8",
    );

    try {
      const result = await runCli(
        ["list", "--config", configPath],
        output.dependencies,
      );

      expect(result).toEqual({ exitCode: 1 });
      expect(output.stdout).toEqual([]);
      expect(JSON.parse(output.stderr[0]!)).toEqual({
        error:
          "Request timeout must be an integer from 1 to 2147483647.",
        code: "invalid_request_timeout",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

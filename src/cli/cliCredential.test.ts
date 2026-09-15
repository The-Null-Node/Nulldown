import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jest } from "@jest/globals";

import {
  createFileCliCredentialTokenProvider,
  readCliCredential,
  writeCliCredential,
} from "./cliCredential";
import { generateCliDeviceKeyPair } from "./auth";
import {
  CLI_CREDENTIAL_KIND_V1,
  type CliCredentialBundleV1,
} from "../../shared/auth/cliDevice";

const createCredential = (overrides: Partial<CliCredentialBundleV1> = {}): CliCredentialBundleV1 => ({
  kind: CLI_CREDENTIAL_KIND_V1,
  version: 1,
  baseUrl: "https://nulldown.test",
  userId: "user-1",
  accountId: "account-1",
  credentialId: "credential-1",
  refreshToken: "refresh-token-1",
  accessToken: "access-token-1",
  accessExpiresAt: Date.now() + 60_000,
  credentialExpiresAt: Date.now() + 86_400_000,
  createdAt: Date.now(),
  ...overrides,
});

const createCredentialPath = async (): Promise<string> =>
  join(await mkdtemp(join(tmpdir(), "nulldown-cli-credential-")), "auth.json");

describe("file CLI credential provider", () => {
  it("returns a current bearer without refreshing", async () => {
    const filePath = await createCredentialPath();
    await writeCliCredential(filePath, createCredential());
    const fetchImpl = jest.fn<typeof fetch>();
    const provider = createFileCliCredentialTokenProvider({
      filePath,
      baseUrl: "https://nulldown.test",
      fetch: fetchImpl,
    });

    await expect(provider()).resolves.toBe("access-token-1");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rotates and atomically persists a near-expiry credential before returning it", async () => {
    const filePath = await createCredentialPath();
    const keys = await generateCliDeviceKeyPair(true);
    const localAuthoring = {
      ...keys.authoring!,
      deviceDelegation: {
        schema: "nulldown.drop-device-delegation.v1" as const,
        version: 1 as const,
        accountId: "account-1",
        credentialId: "credential-1",
        delegateSigningPublicJwk: keys.authoring!.signingPublicJwk,
        encryptionKid: "enc-kid",
        encryptionPublicJwk: { kty: "RSA", n: "n", e: "AQAB" },
        issuedAt: Date.now(),
        expiresAt: Date.now() + 86_400_000,
        signature: { kid: "account-kid", alg: "ECDSA_P256_SHA256" as const, sig: "signature" },
      },
    };
    await writeCliCredential(
      filePath,
      createCredential({ accessExpiresAt: Date.now() + 1, authoring: localAuthoring }),
    );
    const replacement = createCredential({
      refreshToken: "refresh-token-2",
      accessToken: "access-token-2",
      accessExpiresAt: Date.now() + 60_000,
    });
    const events: string[] = [];
    const fetchImpl = jest.fn<typeof fetch>(async (url, init) => {
      expect(url).toBe("https://nulldown.test/api/auth/cli/refresh");
      expect(new Headers(init?.headers).get("Authorization")).toBeNull();
      return Response.json(replacement);
    });
    const provider = createFileCliCredentialTokenProvider({
      filePath,
      baseUrl: "https://nulldown.test",
      fetch: fetchImpl,
      onRefresh: (event) => events.push(event),
    });

    await expect(provider()).resolves.toBe("access-token-2");
    await expect(readCliCredential(filePath)).resolves.toEqual({
      ...replacement,
      authoring: localAuthoring,
    });
    expect(events).toEqual(["started", "completed"]);
  });

  it("coalesces concurrent forced refreshes", async () => {
    const filePath = await createCredentialPath();
    await writeCliCredential(filePath, createCredential({ accessExpiresAt: Date.now() + 1 }));
    const replacement = createCredential({ accessToken: "access-token-2" });
    let releaseFetch: (() => void) | undefined;
    const pendingFetch = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const fetchImpl = jest.fn<typeof fetch>(async () => {
      await pendingFetch;
      return Response.json(replacement);
    });
    const provider = createFileCliCredentialTokenProvider({
      filePath,
      baseUrl: "https://nulldown.test",
      fetch: fetchImpl,
    });

    const first = provider({ forceRefresh: true, rejectedToken: "access-token-1" });
    const second = provider({ forceRefresh: true, rejectedToken: "access-token-1" });
    await Promise.resolve();
    releaseFetch?.();

    await expect(Promise.all([first, second])).resolves.toEqual([
      "access-token-2",
      "access-token-2",
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps the existing credential when refresh validation fails", async () => {
    const filePath = await createCredentialPath();
    const existing = createCredential({ accessExpiresAt: Date.now() + 1 });
    await writeCliCredential(filePath, existing);
    const provider = createFileCliCredentialTokenProvider({
      filePath,
      baseUrl: "https://nulldown.test",
      fetch: async () => Response.json({ invalid: true }),
    });

    await expect(provider()).rejects.toThrow("Nulldown credential refresh failed.");
    await expect(readCliCredential(filePath)).resolves.toEqual(existing);
  });
});

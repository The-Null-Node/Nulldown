import { webcrypto } from "node:crypto";
import { jest } from "@jest/globals";

import type { CliCredentialBundleV1 } from "../../../shared/auth/cliDevice";
import { parseArgs } from "../core/args";
import { createDropCommands } from "./drops";

const createAuthoringCredential = async (): Promise<{
  credential: CliCredentialBundleV1;
  providerPublicJwk: JsonWebKey & { kid?: string };
}> => {
  const [accountEncryptionPair, delegateSigningPair, providerEncryptionPair] =
    (await Promise.all([
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
      crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]),
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
    ])) as [CryptoKeyPair, CryptoKeyPair, CryptoKeyPair];
  const [encryptionPublicJwk, signingPublicJwk, signingPrivateJwk, providerPublicJwk] =
    await Promise.all([
      crypto.subtle.exportKey("jwk", accountEncryptionPair.publicKey),
      crypto.subtle.exportKey("jwk", delegateSigningPair.publicKey),
      crypto.subtle.exportKey("jwk", delegateSigningPair.privateKey),
      crypto.subtle.exportKey("jwk", providerEncryptionPair.publicKey),
    ]);
  return {
    credential: {
      kind: "nulldown.cli-credential.v1",
      version: 1,
      baseUrl: "https://nulldown.test",
      userId: "user-1",
      accountId: "account-1",
      credentialId: "credential-1",
      refreshToken: "refresh-token",
      accessToken: "access-token",
      accessExpiresAt: Date.now() + 60_000,
      credentialExpiresAt: Date.now() + 86_400_000,
      createdAt: Date.now(),
      authoring: {
        signingKid: "delegate-1",
        signingPublicJwk,
        signingPrivateJwk,
        deviceDelegation: {
          schema: "nulldown.drop-device-delegation.v1",
          version: 1,
          accountId: "account-1",
          credentialId: "credential-1",
          delegateSigningPublicJwk: signingPublicJwk,
          encryptionKid: "account-encryption-1",
          encryptionPublicJwk,
          issuedAt: 1,
          expiresAt: Date.now() + 86_400_000,
          signature: { kid: "account-1", alg: "ECDSA_P256_SHA256", sig: "signature" },
        },
      },
    },
    providerPublicJwk: { ...providerPublicJwk, kid: "provider-1" },
  };
};

describe("drop authoring commands", () => {
  beforeAll(() => {
    Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
  });

  it("seals authenticated creates with public metadata and provider escrow", async () => {
    const { credential, providerPublicJwk } = await createAuthoringCredential();
    const created: Array<{ envelope?: unknown }> = [];
    const create = jest.fn(async (request: { envelope?: unknown }) => {
      created.push(request);
      return { id: "drop-1", url: "https://nulldown.test/d/drop-1" };
    });
    const commands = createDropCommands({
      runtime: { drops: { create } } as never,
      print: jest.fn(),
      redact: (value) => value,
      writeText: jest.fn(),
      readInput: async () => "account content",
      parseMetadata: async () => ({ themeId: "night", category: "note" }),
      shouldResolveSeedBranch: () => false,
    });
    const previousProviderKey = process.env.VITE_PROVIDER_ENCRYPTION_PUBLIC_JWK;
    process.env.VITE_PROVIDER_ENCRYPTION_PUBLIC_JWK = JSON.stringify(providerPublicJwk);
    try {
      await commands[0]!.run({
        config: { token: credential.accessToken, authCredential: credential },
        args: parseArgs(["create", "-", "--visibility=public"]),
      });
      await commands[0]!.run({
        config: { token: credential.accessToken, authCredential: credential },
        args: parseArgs(["create", "-"]),
      });
    } finally {
      if (previousProviderKey === undefined) delete process.env.VITE_PROVIDER_ENCRYPTION_PUBLIC_JWK;
      else process.env.VITE_PROVIDER_ENCRYPTION_PUBLIC_JWK = previousProviderKey;
    }

    const request = created[0]!;
    expect(request.envelope).toEqual(expect.objectContaining({
      accountId: "account-1",
      visibility: "public",
      unlockPolicy: "provider-escrow",
      metadata: { themeId: "night", category: "note" },
      providerEscrow: expect.objectContaining({ kid: "provider-1" }),
    }));
    expect(created[1]!.envelope).toEqual(expect.objectContaining({
      visibility: "unlisted",
      unlockPolicy: "provider-escrow",
    }));
  });

  it("refuses an authenticated credential without local authoring authority", async () => {
    const create = jest.fn();
    const commands = createDropCommands({
      runtime: { drops: { create } } as never,
      print: jest.fn(),
      redact: (value) => value,
      writeText: jest.fn(),
      readInput: async () => "account content",
      parseMetadata: async () => undefined,
      shouldResolveSeedBranch: () => false,
    });
    const credential = {
      kind: "nulldown.cli-credential.v1",
      version: 1,
      baseUrl: "https://nulldown.test",
      userId: "user-1",
      accountId: "account-1",
      credentialId: "credential-1",
      refreshToken: "refresh-token",
      accessToken: "access-token",
      accessExpiresAt: Date.now() + 60_000,
      credentialExpiresAt: Date.now() + 86_400_000,
      createdAt: Date.now(),
    } satisfies CliCredentialBundleV1;

    await expect(commands[0]!.run({
      config: { token: credential.accessToken, authCredential: credential },
      args: parseArgs(["create", "-"]),
    })).rejects.toThrow("Run nd auth login again to enable account-owned authoring.");
    expect(create).not.toHaveBeenCalled();
  });

  it("keeps anonymous and explicit legacy creates plaintext", async () => {
    const created: Array<{ envelope?: unknown }> = [];
    const create = jest.fn(async (request: { envelope?: unknown }) => {
      created.push(request);
      return { id: "drop-1", url: "https://nulldown.test/d/drop-1" };
    });
    const commands = createDropCommands({
      runtime: { drops: { create } } as never,
      print: jest.fn(),
      redact: (value) => value,
      writeText: jest.fn(),
      readInput: async () => "plaintext",
      parseMetadata: async () => undefined,
      shouldResolveSeedBranch: () => false,
    });
    const warning = jest.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await commands[0]!.run({ config: {}, args: parseArgs(["create", "-"]) });
      await commands[0]!.run({
        config: { token: "legacy-token" },
        args: parseArgs(["create", "-", "--legacy-plaintext"]),
      });
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("will not enter Remote Library"));
    } finally {
      warning.mockRestore();
    }

    expect(created.map((request) => request.envelope)).toEqual([undefined, undefined]);
  });

  it("seals an update replacement and retains its expected revision", async () => {
    const { credential } = await createAuthoringCredential();
    const update = jest.fn(async () => ({ id: "drop-1", url: "https://nulldown.test/d/drop-1" }));
    const commands = createDropCommands({
      runtime: {
        drops: {
          get: async () => ({
            id: "drop-1",
            revision: "revision-1",
            body: { metadata: { themeId: "existing" } },
          }),
          update,
        },
      } as never,
      print: jest.fn(),
      redact: (value) => value,
      writeText: jest.fn(),
      readInput: async () => "replacement",
      parseMetadata: async () => ({ category: "updated" }),
      shouldResolveSeedBranch: () => false,
    });

    await commands[1]!.run({
      config: { token: credential.accessToken, authCredential: credential },
      args: parseArgs(["update", "drop-1", "-", "--visibility=private"]),
    });

    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      id: "drop-1",
      expectedRevision: "revision-1",
      envelope: expect.objectContaining({
        visibility: "private",
        unlockPolicy: "vault-only",
        metadata: { themeId: "existing", category: "updated" },
      }),
    }));
  });
});

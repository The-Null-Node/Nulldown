import { jest } from "@jest/globals";

import { createAuthCommand } from "./auth";
import { parseArgs } from "../core/args";
import { generateCliDeviceKeyPair } from "../auth";
import {
  CLI_CREDENTIAL_ENVELOPE_KIND_V1,
  CLI_CREDENTIAL_KIND_V1,
  type CliCredentialBundleV1,
  type CliCredentialEnvelopeV1,
} from "../../../shared/auth/cliDevice";

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

const encryptFor = async (
  publicJwk: JsonWebKey,
  bundle: CliCredentialBundleV1,
): Promise<CliCredentialEnvelopeV1> => {
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    publicJwk,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"],
  );
  const contentKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    contentKey,
    new TextEncoder().encode(JSON.stringify(bundle)),
  );
  const wrappedKey = await crypto.subtle.encrypt(
    { name: "RSA-OAEP" },
    publicKey,
    await crypto.subtle.exportKey("raw", contentKey),
  );
  return {
    kind: CLI_CREDENTIAL_ENVELOPE_KIND_V1,
    wrappedKey: toBase64Url(new Uint8Array(wrappedKey)),
    iv: toBase64Url(iv),
    ciphertext: toBase64Url(new Uint8Array(ciphertext)),
  };
};

describe("auth login command", () => {
  it("opens the verification URI, polls, decrypts, and persists the credential", async () => {
    const device = jest.fn();
    const poll = jest.fn();
    const keyPair = await generateCliDeviceKeyPair();
    const bundle: CliCredentialBundleV1 = {
      kind: CLI_CREDENTIAL_KIND_V1,
      version: 1,
      baseUrl: "https://nulldown.app",
      userId: "user-1",
      accountId: "account-1",
      credentialId: "credential-1",
      refreshToken: "refresh-token-value",
      accessToken: "access-token-value",
      accessExpiresAt: Date.now() + 60_000,
      credentialExpiresAt: Date.now() + 86_400_000,
      createdAt: Date.now(),
    };
    let publicKey: JsonWebKey | undefined;
    device.mockImplementation(async (request: { publicKey: JsonWebKey }) => {
      publicKey = request.publicKey;
      return {
        kind: "nulldown.cli-device.v1",
        deviceCode: "A".repeat(43),
        userCode: "ABCD-EFGH-JKLM",
        verificationUri: "https://nulldown.app/auth/cli?code=ABCD-EFGH-JKLM",
        expiresAt: Date.now() + 60_000,
        interval: 1,
      };
    });
    poll.mockImplementation(async () => ({
      status: "approved",
      envelope: await encryptFor(publicKey!, bundle),
    }));
    const writeCredential = jest.fn(async () => undefined);
    const print = jest.fn();
    const command = createAuthCommand({
      runtime: { auth: { device, poll } } as never,
      print,
      readInput: async () => "{}",
      baseUrl: () => "https://nulldown.app",
      authFilePath: () => "/tmp/auth.json",
      readCredential: async () => null,
      writeCredential,
      clearCredential: async () => undefined,
      openBrowser: jest.fn(async () => undefined),
      sleep: jest.fn(async () => undefined),
    });

    await command.run({
      config: {},
      args: parseArgs(["auth", "login", "--name", "test-cli"]),
    });

    expect(device).toHaveBeenCalledWith({ publicKey: expect.any(Object), clientName: "test-cli" });
    expect(poll).toHaveBeenCalledWith({ deviceCode: "A".repeat(43) });
    expect(writeCredential).toHaveBeenCalledWith(bundle);
    expect(print).toHaveBeenCalledWith(
      expect.objectContaining({ authenticated: true, accountId: "account-1" }),
    );
  });
});

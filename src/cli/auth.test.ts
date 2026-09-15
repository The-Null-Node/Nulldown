import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  clearCliCredential,
  decryptCliCredentialEnvelope,
  generateCliDeviceKeyPair,
  isCliCredentialForBaseUrl,
  readCliCredential,
  writeCliCredential,
} from "./auth";
import {
  CLI_CREDENTIAL_ENVELOPE_KIND_V1,
  CLI_CREDENTIAL_KIND_V1,
  type CliCredentialBundleV1,
  type CliCredentialEnvelopeV1,
} from "../../shared/auth/cliDevice";

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

describe("CLI credential storage", () => {
  it("decrypts the one-time envelope and atomically persists private credentials", async () => {
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
    const envelope = await encryptFor(keyPair.publicKey, bundle);
    await expect(decryptCliCredentialEnvelope(envelope, keyPair.privateKey)).resolves.toEqual(
      bundle,
    );

    const directory = await mkdtemp(join(tmpdir(), "nulldown-cli-auth-"));
    const filePath = join(directory, "auth.json");
    await writeCliCredential(filePath, bundle);
    await expect(readCliCredential(filePath)).resolves.toEqual(bundle);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    expect(await readFile(filePath, "utf8")).not.toContain("[redacted]");
    expect(isCliCredentialForBaseUrl(bundle, "https://nulldown.app")).toBe(true);
    expect(isCliCredentialForBaseUrl(bundle, "https://other.example")).toBe(false);

    await clearCliCredential(filePath);
    await expect(readCliCredential(filePath)).resolves.toBeNull();
  });
});

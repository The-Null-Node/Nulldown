import {
  CLI_CREDENTIAL_ENVELOPE_KIND_V1,
  CLI_CREDENTIAL_KIND_V1,
  formatCliUserCode,
  isCliCredentialBundle,
  isCliCredentialEnvelope,
  isCliDeviceAuthoring,
  isCliEncryptionPublicJwk,
  normalizeCliUserCode,
} from "./cliDevice";
import {
  DROP_DEVICE_DELEGATION_SCHEMA,
  DROP_DEVICE_DELEGATION_VERSION,
} from "../drop/deviceDelegation";

describe("CLI device authorization contract", () => {
  it("normalizes and formats human approval codes", () => {
    expect(normalizeCliUserCode("abcd-efgh-jklm")).toBe("ABCDEFGHJKLM");
    expect(formatCliUserCode("ABCDEFGHJKLM")).toBe("ABCD-EFGH-JKLM");
    expect(normalizeCliUserCode("too-short")).toBeNull();
  });

  it("accepts only public RSA encryption keys", () => {
    expect(
      isCliEncryptionPublicJwk({
        kty: "RSA",
        n: "n".repeat(342),
        e: "AQAB",
      }),
    ).toBe(true);
    expect(
      isCliEncryptionPublicJwk({
        kty: "RSA",
        n: "n".repeat(342),
        e: "AQAB",
        d: "private",
      }),
    ).toBe(false);
  });

  it("validates encrypted envelopes and decrypted credential metadata", () => {
    expect(
      isCliCredentialEnvelope({
        kind: CLI_CREDENTIAL_ENVELOPE_KIND_V1,
        wrappedKey: "wrapped",
        iv: "iv",
        ciphertext: "ciphertext",
      }),
    ).toBe(true);
    expect(
      isCliCredentialBundle({
        kind: CLI_CREDENTIAL_KIND_V1,
        version: 1,
        baseUrl: "https://nulldown.app",
        userId: "user-1",
        accountId: "account-1",
        credentialId: "credential-1",
        refreshToken: "refresh-token",
        accessToken: "access-token",
        accessExpiresAt: 2,
        credentialExpiresAt: 3,
        createdAt: 1,
      }),
    ).toBe(true);
  });

  it("requires persisted authoring material to match its account and credential", () => {
    const delegation = {
      schema: DROP_DEVICE_DELEGATION_SCHEMA,
      version: DROP_DEVICE_DELEGATION_VERSION,
      accountId: "account-1",
      credentialId: "credential-1",
      delegateSigningPublicJwk: { kty: "EC", crv: "P-256", x: "delegate-x", y: "delegate-y" },
      encryptionKid: "enc-1",
      encryptionPublicJwk: { kty: "RSA", n: "encryption-n", e: "AQAB" },
      issuedAt: 100,
      expiresAt: 200,
      signature: { kid: "account-key", alg: "ECDSA_P256_SHA256" as const, sig: "sig" },
    };
    const authoring = {
      signingKid: "delegate-key",
      signingPublicJwk: delegation.delegateSigningPublicJwk,
      signingPrivateJwk: { ...delegation.delegateSigningPublicJwk, d: "delegate-private" },
      deviceDelegation: delegation,
    };
    const credential = {
      kind: CLI_CREDENTIAL_KIND_V1,
      version: 1 as const,
      baseUrl: "https://nulldown.app",
      userId: "user-1",
      accountId: "account-1",
      credentialId: "credential-1",
      refreshToken: "refresh-token",
      accessToken: "access-token",
      accessExpiresAt: 300,
      credentialExpiresAt: 400,
      createdAt: 100,
      authoring,
    };

    expect(isCliDeviceAuthoring(authoring)).toBe(true);
    expect(isCliCredentialBundle(credential)).toBe(true);
    expect(isCliCredentialBundle({ ...credential, credentialId: "other" })).toBe(false);
  });
});

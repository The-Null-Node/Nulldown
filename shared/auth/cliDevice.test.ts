import {
  CLI_CREDENTIAL_ENVELOPE_KIND_V1,
  CLI_CREDENTIAL_KIND_V1,
  formatCliUserCode,
  isCliCredentialBundle,
  isCliCredentialEnvelope,
  isCliEncryptionPublicJwk,
  normalizeCliUserCode,
} from "./cliDevice";

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
});

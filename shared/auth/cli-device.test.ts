import {
  decodeCliCredentialBundle,
  decodeCliCredentialEnvelope,
  decodeCliDeviceStartResponse,
  encodeCliCredentialBundle,
  encodeCliCredentialEnvelope,
  encodeCliDeviceStartResponse,
  formatCliUserCode,
  isCliCredentialBundle,
  isCliCredentialEnvelope,
  isCliDeviceAuthoring,
  isCliEncryptionPublicJwk,
  normalizeCliUserCode,
} from "./codecs/cli-device-v1";
import type { CliCredentialBundle } from "./cli-device";

describe("CLI device authorization contract", () => {
  it("accepts the persisted v1 CLI authoring credential without changing delegated ownership", () => {
    const raw =
      '{"kind":"nulldown.cli-credential.v1","version":1,"baseUrl":"https://nulldown.test","userId":"user-fixture","accountId":"account-fixture","credentialId":"credential-fixture","refreshToken":"synthetic-refresh-token","accessToken":"synthetic-access-token","accessExpiresAt":1700000060000,"credentialExpiresAt":1700086400000,"createdAt":1700000000000,"authoring":{"signingKid":"delegate-fixture","signingPublicJwk":{"kty":"EC","crv":"P-256","x":"fixture-x","y":"fixture-y"},"signingPrivateJwk":{"kty":"EC","crv":"P-256","x":"fixture-x","y":"fixture-y","d":"synthetic-private-material"},"deviceDelegation":{"schema":"nulldown.drop-device-delegation.v1","version":1,"accountId":"account-fixture","credentialId":"credential-fixture","delegateSigningPublicJwk":{"kty":"EC","crv":"P-256","x":"fixture-x","y":"fixture-y"},"encryptionKid":"enc-fixture","encryptionPublicJwk":{"kty":"RSA","n":"synthetic-modulus","e":"AQAB"},"issuedAt":1700000000000,"expiresAt":1700086400000,"signature":{"kid":"account-signing-fixture","alg":"ECDSA_P256_SHA256","sig":"synthetic-signature"}}}}';
    const parsed = JSON.parse(raw) as unknown;

    const credential = decodeCliCredentialBundle(parsed);

    expect(isCliCredentialBundle(parsed)).toBe(true);
    expect(JSON.stringify(encodeCliCredentialBundle(credential!))).toBe(raw);
    expect(credential).toMatchObject({
      accountId: "account-fixture",
      credentialId: "credential-fixture",
      authoring: {
        signingKid: "delegate-fixture",
        deviceDelegation: {
          accountId: "account-fixture",
          credentialId: "credential-fixture",
          encryptionKid: "enc-fixture",
        },
      },
    });
    expect(credential).not.toHaveProperty("kind");
    expect(credential).not.toHaveProperty("version");
  });

  it("accepts the encrypted one-time credential envelope without interpreting ciphertext", () => {
    const raw =
      '{"kind":"nulldown.cli-credential-envelope.v1","wrappedKey":"c3ludGhldGljLXdyYXBwZWQta2V5","iv":"c3ludGhldGljLWl2","ciphertext":"AAECA_7_synthetic_ciphertext"}';
    const parsed = JSON.parse(raw) as unknown;

    const envelope = decodeCliCredentialEnvelope(parsed);

    expect(isCliCredentialEnvelope(parsed)).toBe(true);
    expect(envelope).toEqual({
      wrappedKey: "c3ludGhldGljLXdyYXBwZWQta2V5",
      iv: "c3ludGhldGljLWl2",
      ciphertext: "AAECA_7_synthetic_ciphertext",
    });
    expect(JSON.stringify(encodeCliCredentialEnvelope(envelope!))).toBe(raw);
  });

  it("round-trips the V1 device start response without retaining its wire kind", () => {
    const raw =
      '{"kind":"nulldown.cli-device.v1","deviceCode":"device","userCode":"ABCD-EFGH-JKLM","verificationUri":"https://nulldown.test/device","expiresAt":1700000000000,"interval":5}';
    const response = decodeCliDeviceStartResponse(JSON.parse(raw));

    expect(response).toEqual({
      deviceCode: "device",
      userCode: "ABCD-EFGH-JKLM",
      verificationUri: "https://nulldown.test/device",
      expiresAt: 1700000000000,
      interval: 5,
    });
    expect(JSON.stringify(encodeCliDeviceStartResponse(response!))).toBe(raw);
  });

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
      isCliCredentialEnvelope(
        encodeCliCredentialEnvelope({
          wrappedKey: "wrapped",
          iv: "iv",
          ciphertext: "ciphertext",
        }),
      ),
    ).toBe(true);
    expect(
      isCliCredentialBundle(encodeCliCredentialBundle({
        baseUrl: "https://nulldown.app",
        userId: "user-1",
        accountId: "account-1",
        credentialId: "credential-1",
        refreshToken: "refresh-token",
        accessToken: "access-token",
        accessExpiresAt: 2,
        credentialExpiresAt: 3,
        createdAt: 1,
      })),
    ).toBe(true);
  });

  it("requires persisted authoring material to match its account and credential", () => {
    const delegation = {
      accountId: "account-1",
      credentialId: "credential-1",
      delegateSigningPublicJwk: {
        kty: "EC",
        crv: "P-256",
        x: "delegate-x",
        y: "delegate-y",
      },
      encryptionKid: "enc-1",
      encryptionPublicJwk: { kty: "RSA", n: "encryption-n", e: "AQAB" },
      issuedAt: 100,
      expiresAt: 200,
      signature: {
        kid: "account-key",
        alg: "ECDSA_P256_SHA256" as const,
        sig: "sig",
      },
    };
    const authoring = {
      signingKid: "delegate-key",
      signingPublicJwk: delegation.delegateSigningPublicJwk,
      signingPrivateJwk: {
        ...delegation.delegateSigningPublicJwk,
        d: "delegate-private",
      },
      deviceDelegation: delegation,
    };
    const credential = {
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
    } satisfies CliCredentialBundle;

    const encodedCredential = encodeCliCredentialBundle(credential);
    expect(isCliDeviceAuthoring(encodedCredential.authoring)).toBe(true);
    expect(isCliCredentialBundle(encodedCredential)).toBe(true);
    expect(
      isCliCredentialBundle({ ...encodedCredential, credentialId: "other" }),
    ).toBe(false);
  });
});

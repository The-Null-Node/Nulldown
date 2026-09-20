import {
  decodeDropDeviceDelegation,
  encodeDropDeviceDelegation,
  isDropDeviceDelegation,
  serializeDropDeviceDelegationForSignature,
  toDropDeviceDelegationSignable,
} from "./codecs/device-delegation-v1";
import type { DropDeviceDelegation } from "./deviceDelegation";

const createDelegation = (): DropDeviceDelegation => ({
  accountId: "account-1",
  credentialId: "credential-1",
  delegateSigningPublicJwk: {
    kty: "EC",
    crv: "P-256",
    x: "delegate-x",
    y: "delegate-y",
  },
  encryptionKid: "enc-1",
  encryptionPublicJwk: {
    kty: "RSA",
    n: "encryption-n",
    e: "AQAB",
  },
  issuedAt: 100,
  expiresAt: 200,
  signature: {
    kid: "account-signing-key",
    alg: "ECDSA_P256_SHA256",
    sig: "root-signature",
  },
});

describe("drop device delegation", () => {
  it("accepts the exact persisted v1 fixture without changing its representation", () => {
    const raw =
      '{"schema":"nulldown.drop-device-delegation.v1","version":1,"accountId":"account-1","credentialId":"credential-1","delegateSigningPublicJwk":{"kty":"EC","crv":"P-256","x":"delegate-x","y":"delegate-y"},"encryptionKid":"enc-1","encryptionPublicJwk":{"kty":"RSA","n":"encryption-n","e":"AQAB"},"issuedAt":100,"expiresAt":200,"signature":{"kid":"account-signing-key","alg":"ECDSA_P256_SHA256","sig":"root-signature"}}';
    const parsed = JSON.parse(raw) as unknown;

    const delegation = decodeDropDeviceDelegation(parsed);

    expect(isDropDeviceDelegation(delegation)).toBe(true);
    expect(delegation).toEqual(createDelegation());
    expect(JSON.stringify(encodeDropDeviceDelegation(delegation!))).toBe(raw);
  });

  it("serializes the certificate body without its root signature", () => {
    const delegation = createDelegation();

    expect(
      serializeDropDeviceDelegationForSignature(
        toDropDeviceDelegationSignable(delegation),
      ),
    ).toBe(
      '{"accountId":"account-1","credentialId":"credential-1","delegateSigningPublicJwk":{"crv":"P-256","kty":"EC","x":"delegate-x","y":"delegate-y"},"encryptionKid":"enc-1","encryptionPublicJwk":{"e":"AQAB","kty":"RSA","n":"encryption-n"},"expiresAt":200,"issuedAt":100,"schema":"nulldown.drop-device-delegation.v1","version":1}',
    );
  });

  it("rejects expired certificates and public JWKs containing private material", () => {
    const delegation = createDelegation();
    const missingSignature = Object.fromEntries(
      Object.entries(delegation).filter(([field]) => field !== "signature"),
    );

    expect(isDropDeviceDelegation(delegation)).toBe(true);
    expect(() => isDropDeviceDelegation(missingSignature)).not.toThrow();
    expect(isDropDeviceDelegation(missingSignature)).toBe(false);
    expect(isDropDeviceDelegation({ ...delegation, expiresAt: 100 })).toBe(
      false,
    );
    expect(
      isDropDeviceDelegation({
        ...delegation,
        delegateSigningPublicJwk: {
          ...delegation.delegateSigningPublicJwk,
          d: "private",
        },
      }),
    ).toBe(false);
    expect(
      isDropDeviceDelegation({
        ...delegation,
        encryptionPublicJwk: {
          ...delegation.encryptionPublicJwk,
          d: "private",
        },
      }),
    ).toBe(false);
    expect(isDropDeviceDelegation({ ...delegation, unexpected: true })).toBe(
      false,
    );
  });
});

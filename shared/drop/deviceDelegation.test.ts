import {
  DROP_DEVICE_DELEGATION_SCHEMA,
  DROP_DEVICE_DELEGATION_VERSION,
  isDropDeviceDelegation,
  serializeDropDeviceDelegationForSignature,
  toDropDeviceDelegationSignable,
  type DropDeviceDelegation,
} from "./deviceDelegation";

const createDelegation = (): DropDeviceDelegation => ({
  schema: DROP_DEVICE_DELEGATION_SCHEMA,
  version: DROP_DEVICE_DELEGATION_VERSION,
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
  signature: { kid: "account-signing-key", alg: "ECDSA_P256_SHA256", sig: "root-signature" },
});

describe("drop device delegation", () => {
  it("serializes the certificate body without its root signature", () => {
    expect(
      serializeDropDeviceDelegationForSignature(
        toDropDeviceDelegationSignable(createDelegation()),
      ),
    ).toBe(
      '{"accountId":"account-1","credentialId":"credential-1","delegateSigningPublicJwk":{"crv":"P-256","kty":"EC","x":"delegate-x","y":"delegate-y"},"encryptionKid":"enc-1","encryptionPublicJwk":{"e":"AQAB","kty":"RSA","n":"encryption-n"},"expiresAt":200,"issuedAt":100,"schema":"nulldown.drop-device-delegation.v1","version":1}',
    );
  });

  it("rejects expiry, private JWK material, and unexpected fields", () => {
    const delegation = createDelegation();
    expect(isDropDeviceDelegation(delegation)).toBe(true);
    expect(isDropDeviceDelegation({ ...delegation, expiresAt: 100 })).toBe(false);
    expect(
      isDropDeviceDelegation({
        ...delegation,
        delegateSigningPublicJwk: { ...delegation.delegateSigningPublicJwk, d: "private" },
      }),
    ).toBe(false);
    expect(
      isDropDeviceDelegation({
        ...delegation,
        encryptionPublicJwk: { ...delegation.encryptionPublicJwk, d: "private" },
      }),
    ).toBe(false);
    expect(isDropDeviceDelegation({ ...delegation, unexpected: true })).toBe(false);
  });
});

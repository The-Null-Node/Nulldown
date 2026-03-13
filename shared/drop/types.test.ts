import {
  DROP_ENVELOPE_SCHEMA_V1,
  DROP_ENVELOPE_VERSION_V1,
  isDropDraftPackV1,
  isDropEnvelopeV1,
  isDropPayload,
  serializeCanonicalJson,
  serializeDropEnvelopeForProviderSignature,
  type DropEnvelopeV1,
} from "./types";

describe("drop types", () => {
  it("validates drop payloads", () => {
    expect(isDropPayload({ content: "hello" })).toBe(true);
    expect(isDropPayload({ content: "hello", metadata: { themeId: "system" } })).toBe(
      true,
    );
    expect(
      isDropPayload({
        content: "hello",
        draftPack: {
          version: 1,
          policy: "always",
          source: "new-drop",
          createdAt: Date.now(),
          snapshots: [
            {
              snapshotId: 7,
              createdAt: Date.now(),
              fromLength: 0,
              toLength: 5,
              ops: [
                {
                  type: "insert",
                  start: 0,
                  end: 0,
                  text: "hello",
                },
              ],
            },
          ],
        },
      }),
    ).toBe(true);
    expect(isDropPayload({ metadata: {} })).toBe(false);
    expect(isDropPayload({ content: 42 })).toBe(false);
  });

  it("validates draft packs", () => {
    expect(
      isDropDraftPackV1({
        version: 1,
        policy: "edited-only",
        source: "edited-drop",
        createdAt: 123,
        currentSnapshotId: 9,
        truncated: false,
        snapshots: [
          {
            snapshotId: 9,
            createdAt: 123,
            fromLength: 12,
            toLength: 14,
            ops: [
              {
                type: "insert",
                start: 12,
                end: 12,
                text: "!!",
              },
            ],
          },
        ],
      }),
    ).toBe(true);

    expect(
      isDropDraftPackV1({
        version: 1,
        policy: "sometimes",
        source: "new-drop",
        createdAt: 123,
        snapshots: [],
      }),
    ).toBe(false);
  });

  it("validates v1 encrypted drop envelope", () => {
    const envelope: DropEnvelopeV1 = {
      schema: DROP_ENVELOPE_SCHEMA_V1,
      version: DROP_ENVELOPE_VERSION_V1,
      createdAt: Date.now(),
      accountId: "account-1",
      metadata: { themeId: "system" },
      cipher: {
        alg: "A256GCM",
        iv: "iv",
        ciphertext: "cipher",
      },
      keyEnvelope: {
        mode: "account-vault-rsa-oaep",
        kid: "enc-1",
        wrappedKey: "wrapped",
      },
      signatures: {
        device: {
          kid: "sig-1",
          alg: "ECDSA_P256_SHA256",
          sig: "signature",
        },
      },
    };

    expect(isDropEnvelopeV1(envelope)).toBe(true);
    expect(
      isDropEnvelopeV1({
        ...envelope,
        schema: "wrong-schema",
      }),
    ).toBe(false);
  });

  it("serializes canonical JSON with stable key order", () => {
    const value = {
      b: 1,
      a: {
        d: 2,
        c: 3,
      },
    };

    expect(serializeCanonicalJson(value)).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("provider signature payload includes only device signature", () => {
    const envelope: DropEnvelopeV1 = {
      schema: DROP_ENVELOPE_SCHEMA_V1,
      version: DROP_ENVELOPE_VERSION_V1,
      createdAt: 123,
      accountId: "account-1",
      metadata: { themeId: "system" },
      cipher: {
        alg: "A256GCM",
        iv: "iv",
        ciphertext: "cipher",
      },
      keyEnvelope: {
        mode: "account-vault-rsa-oaep",
        kid: "enc-1",
        wrappedKey: "wrapped",
      },
      signatures: {
        device: {
          kid: "device-kid",
          alg: "ECDSA_P256_SHA256",
          sig: "device-sig",
        },
        provider: {
          kid: "provider-kid",
          alg: "ECDSA_P256_SHA256",
          sig: "provider-sig",
        },
      },
    };

    const serialized = serializeDropEnvelopeForProviderSignature(envelope);
    const parsed = JSON.parse(serialized) as {
      signatures: { device: { sig: string }; provider?: { sig: string } };
    };

    expect(parsed.signatures.device.sig).toBe("device-sig");
    expect(parsed.signatures.provider).toBeUndefined();
  });
});

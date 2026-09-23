import {
  decodeDropEnvelope,
  encodeDropEnvelope,
  isDropEnvelope,
  serializeDropEnvelopeForDeviceSignature,
  serializeDropEnvelopeForProviderSignature,
  toDropEnvelopeSignable,
} from "./codecs/envelope-v1";
import {
  isDropStrategyRef,
  serializeCanonicalJson,
  type DropEnvelope,
} from "./types";
import {
  decodeDropPayload,
  encodeDropPayload,
  isDropDraftPack,
  isDropPayload,
} from "./codecs/draft-pack-v1";

describe("drop types", () => {
  it("validates only same-root strategy branch references", () => {
    const rootDropId = "root-drop";
    const ref = {
      kind: "branch",
      rootDropId,
      branchId: "clone_account:account-1",
    };

    expect(isDropStrategyRef(ref, rootDropId)).toBe(true);
    for (const strategyRef of [
      null,
      {},
      [],
      { ...ref, kind: "root" },
      { ...ref, rootDropId: "other-root" },
      { ...ref, rootDropId: " root-drop" },
      { ...ref, branchId: "" },
      { ...ref, branchId: " branch" },
    ]) {
      expect(isDropStrategyRef(strategyRef, rootDropId)).toBe(false);
      expect(
        isDropPayload({ content: "title", metadata: { strategyRef } }),
      ).toBe(true);
    }
  });

  it("decodes the legacy plaintext payload fixture without rewriting metadata", () => {
    const raw =
      '{"content":"legacy plaintext","draftPack":{"version":1,"policy":"edited-only","source":"edited-drop","createdAt":1700000000000,"snapshots":[{"snapshotId":4,"createdAt":1700000000000,"fromLength":6,"toLength":16,"ops":[{"type":"insert","start":6,"end":6,"text":" plaintext"}]}]}}';
    const parsed = JSON.parse(raw) as unknown;

    const payload = decodeDropPayload(parsed);

    expect(isDropPayload(parsed)).toBe(true);
    expect(isDropDraftPack((parsed as { draftPack?: unknown }).draftPack)).toBe(
      true,
    );
    expect(payload).toEqual({
      content: "legacy plaintext",
      draftPack: {
        policy: "edited-only",
        source: "edited-drop",
        createdAt: 1700000000000,
        snapshots: [
          {
            snapshotId: 4,
            createdAt: 1700000000000,
            fromLength: 6,
            toLength: 16,
            ops: [{ type: "insert", start: 6, end: 6, text: " plaintext" }],
          },
        ],
      },
    });
    expect(JSON.stringify(encodeDropPayload(payload!))).toBe(raw);
  });

  it("validates drop payloads", () => {
    expect(isDropPayload({ content: "hello" })).toBe(true);
    expect(
      isDropPayload({ content: "hello", metadata: { themeId: "system" } }),
    ).toBe(true);
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
      isDropDraftPack({
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
      isDropDraftPack({
        version: 1,
        policy: "sometimes",
        source: "new-drop",
        createdAt: 123,
        snapshots: [],
      }),
    ).toBe(false);
  });

  it("validates v1 encrypted drop envelope", () => {
    const envelope: DropEnvelope = {
      createdAt: Date.now(),
      accountId: "account-1",
      visibility: "private",
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

    expect(isDropEnvelope(encodeDropEnvelope(envelope))).toBe(true);
    for (const strategyRef of [null, {}, { kind: "unknown" }]) {
      expect(
        isDropEnvelope(
          encodeDropEnvelope({
            ...envelope,
            metadata: { strategyRef },
          } as unknown as DropEnvelope),
        ),
      ).toBe(true);
    }
    expect(
      isDropEnvelope({
        ...encodeDropEnvelope(envelope),
        schema: "wrong-schema",
      }),
    ).toBe(false);
  });

  it("preserves legacy v1 envelope ciphertext and exact device signable bytes", () => {
    const raw =
      '{"schema":"nmdn.drop.v1","version":1,"createdAt":1700000000000,"accountId":"fixture-account","legacyExtension":{"source":"v1"},"cipher":{"alg":"A256GCM","iv":"AQIDBA","ciphertext":"BQYHCA"},"keyEnvelope":{"mode":"account-vault-rsa-oaep","kid":"enc-fixture","wrappedKey":"CQoLDA"},"signatures":{"device":{"kid":"sig-fixture","alg":"ECDSA_P256_SHA256","sig":"DQ4PEA"},"provider":{"kid":"provider-fixture","alg":"ECDSA_P256_SHA256","sig":"ERITFA"}}}';
    const parsed = JSON.parse(raw) as unknown;

    const envelope = decodeDropEnvelope(parsed);
    expect(isDropEnvelope(parsed)).toBe(true);
    if (!envelope) throw new Error("fixture must be a v1 envelope");

    expect(JSON.stringify(encodeDropEnvelope(envelope))).toBe(raw);
    expect(envelope.cipher).toEqual({
      alg: "A256GCM",
      iv: "AQIDBA",
      ciphertext: "BQYHCA",
    });
    expect(envelope.keyEnvelope.wrappedKey).toBe("CQoLDA");
    expect(envelope).toMatchObject({ legacyExtension: { source: "v1" } });
    expect(envelope.signatures).toEqual({
      device: {
        kid: "sig-fixture",
        alg: "ECDSA_P256_SHA256",
        sig: "DQ4PEA",
      },
      provider: {
        kid: "provider-fixture",
        alg: "ECDSA_P256_SHA256",
        sig: "ERITFA",
      },
    });
    expect(envelope).not.toHaveProperty("schema");
    expect(envelope).not.toHaveProperty("version");
    expect(
      serializeDropEnvelopeForDeviceSignature(toDropEnvelopeSignable(envelope)),
    ).toBe(
      '{"accountId":"fixture-account","cipher":{"alg":"A256GCM","ciphertext":"BQYHCA","iv":"AQIDBA"},"createdAt":1700000000000,"keyEnvelope":{"kid":"enc-fixture","mode":"account-vault-rsa-oaep","wrappedKey":"CQoLDA"},"schema":"nmdn.drop.v1","version":1}',
    );
  });

  it("preserves the legacy provider countersignature payload", () => {
    const raw =
      '{"schema":"nmdn.drop.v1","version":1,"createdAt":1700000000000,"accountId":"fixture-account","cipher":{"alg":"A256GCM","iv":"AQIDBA","ciphertext":"BQYHCA"},"keyEnvelope":{"mode":"account-vault-rsa-oaep","kid":"enc-fixture","wrappedKey":"CQoLDA"},"signatures":{"device":{"kid":"sig-fixture","alg":"ECDSA_P256_SHA256","sig":"DQ4PEA"},"provider":{"kid":"provider-fixture","alg":"ECDSA_P256_SHA256","sig":"ERITFA"}}}';
    const parsed = JSON.parse(raw) as unknown;

    const envelope = decodeDropEnvelope(parsed);
    if (!envelope) throw new Error("fixture must be a v1 envelope");

    expect(serializeDropEnvelopeForProviderSignature(envelope)).toBe(
      '{"accountId":"fixture-account","cipher":{"alg":"A256GCM","ciphertext":"BQYHCA","iv":"AQIDBA"},"createdAt":1700000000000,"keyEnvelope":{"kid":"enc-fixture","mode":"account-vault-rsa-oaep","wrappedKey":"CQoLDA"},"schema":"nmdn.drop.v1","signatures":{"device":{"alg":"ECDSA_P256_SHA256","kid":"sig-fixture","sig":"DQ4PEA"}},"version":1}',
    );
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

  it("preserves direct envelope signature bytes when delegation is absent", () => {
    const envelope: DropEnvelope = {
      createdAt: 123,
      accountId: "account-1",
      cipher: { alg: "A256GCM", iv: "iv", ciphertext: "cipher" },
      keyEnvelope: {
        mode: "account-vault-rsa-oaep",
        kid: "enc-1",
        wrappedKey: "wrapped",
      },
      deviceSignerPublicJwk: {
        kty: "EC",
        crv: "P-256",
        x: "x",
        y: "y",
      },
      signatures: {
        device: { kid: "sig-1", alg: "ECDSA_P256_SHA256", sig: "signature" },
      },
    };
    const legacyBytes = serializeCanonicalJson({
      schema: "nmdn.drop.v1",
      version: 1,
      createdAt: 123,
      accountId: "account-1",
      cipher: { alg: "A256GCM", iv: "iv", ciphertext: "cipher" },
      keyEnvelope: {
        mode: "account-vault-rsa-oaep",
        kid: "enc-1",
        wrappedKey: "wrapped",
      },
      deviceSignerPublicJwk: {
        kty: "EC",
        crv: "P-256",
        x: "x",
        y: "y",
      },
    });

    expect(
      serializeDropEnvelopeForDeviceSignature(toDropEnvelopeSignable(envelope)),
    ).toBe(legacyBytes);
  });

  it("provider signature payload includes only device signature", () => {
    const envelope: DropEnvelope = {
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

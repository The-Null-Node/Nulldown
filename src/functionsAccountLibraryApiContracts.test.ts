import { describe, expect, it, jest } from "@jest/globals";
import {
  listAccountLibraryEntries,
  tombstoneAccountLibraryEntry,
  upsertAccountLibraryEntry,
} from "../functions/api/_lib/accounts/library/repository";
import {
  AccountLibraryError,
  projectAccountLibraryEnvelope,
  verifyAccountLibraryEnvelope,
  verifyAccountLibraryEnvelopeOwnership,
} from "../functions/api/_lib/accounts/library/service";
import { verifyDropDeviceDelegationSignature } from "../functions/api/_lib/crypto/envelopes/verification";
import { issueAccountSessionToken } from "../functions/api/_lib/accounts/session/auth";
import {
  serializeDropDeviceDelegationForSignature,
  toDropDeviceDelegationSignable,
  type DropDeviceDelegation,
} from "../shared/drop/deviceDelegation";
import {
  serializeDropEnvelopeForDeviceSignature,
  toDropEnvelopeSignable,
  type DropEnvelopeV1,
} from "../shared/drop/types";

const toBase64Url = (bytes: ArrayBuffer): string => {
  let binary = "";
  new Uint8Array(bytes).forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

const credentialId = "A".repeat(22);

const signDelegation = async (
  delegation: DropDeviceDelegation,
  signingKey: CryptoKey,
): Promise<void> => {
  delegation.signature.sig = toBase64Url(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      signingKey,
      new TextEncoder().encode(
        serializeDropDeviceDelegationForSignature(toDropDeviceDelegationSignable(delegation)),
      ),
    ),
  );
};

const signEnvelope = async (envelope: DropEnvelopeV1, signingKey: CryptoKey): Promise<void> => {
  envelope.signatures.device.sig = toBase64Url(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      signingKey,
      new TextEncoder().encode(
        serializeDropEnvelopeForDeviceSignature(toDropEnvelopeSignable(envelope)),
      ),
    ),
  );
};

const rows = [
  {
    entry_seq: 12,
    drop_id: "drop_new",
    account_id: "account_a",
    visibility: "private" as const,
    created_at: 1,
    updated_at: 4,
    deleted_at: null,
  },
  {
    entry_seq: 11,
    drop_id: "drop_deleted",
    account_id: "account_a",
    visibility: "unlisted" as const,
    created_at: 2,
    updated_at: 5,
    deleted_at: 6,
  },
  {
    entry_seq: 10,
    drop_id: "drop_later_page",
    account_id: "account_a",
    visibility: "public" as const,
    created_at: 3,
    updated_at: 7,
    deleted_at: null,
  },
];

const createDatabase = () => {
  const bind = jest.fn().mockReturnThis();
  const all = jest.fn().mockResolvedValue({ results: rows });
  const run = jest.fn().mockResolvedValue({ success: true });
  const prepare = jest.fn(() => ({ bind, all, run }));
  return { prepare, bind, all, run };
};

const signDelegatedEnvelope = async (): Promise<{
  envelope: DropEnvelopeV1;
  accountPublicJwk: JsonWebKey;
  accountPrivateKey: CryptoKey;
  delegatePrivateKey: CryptoKey;
  encryptionPublicJwk: JsonWebKey;
}> => {
  const accountPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const delegatePair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const encryptionPair = await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  );
  const accountPublicJwk = await crypto.subtle.exportKey("jwk", accountPair.publicKey);
  const delegateSigningPublicJwk = await crypto.subtle.exportKey("jwk", delegatePair.publicKey);
  const exportedEncryptionPublicJwk = await crypto.subtle.exportKey("jwk", encryptionPair.publicKey);
  const encryptionPublicJwk = {
    kty: exportedEncryptionPublicJwk.kty,
    n: exportedEncryptionPublicJwk.n,
    e: exportedEncryptionPublicJwk.e,
  };
  const delegation: DropDeviceDelegation = {
    schema: "nulldown.drop-device-delegation.v1",
    version: 1,
    accountId: "account_a",
    credentialId,
    delegateSigningPublicJwk,
    encryptionKid: "enc_a",
    encryptionPublicJwk: exportedEncryptionPublicJwk,
    issuedAt: Date.now() - 1,
    expiresAt: Date.now() + 60_000,
    signature: { kid: "account_a", alg: "ECDSA_P256_SHA256", sig: "placeholder" },
  };
  await signDelegation(delegation, accountPair.privateKey);
  const envelope: DropEnvelopeV1 = {
    schema: "nmdn.drop.v1",
    version: 1,
    createdAt: Date.now(),
    accountId: "account_a",
    visibility: "private",
    cipher: { alg: "A256GCM", iv: "iv", ciphertext: "cipher" },
    keyEnvelope: { mode: "account-vault-rsa-oaep", kid: "enc_a", wrappedKey: "wrapped" },
    deviceSignerPublicJwk: delegateSigningPublicJwk,
    deviceDelegation: delegation,
    signatures: {
      device: { kid: "delegate", alg: "ECDSA_P256_SHA256", sig: "placeholder" },
    },
  };
  await signEnvelope(envelope, delegatePair.privateKey);
  return {
    envelope,
    accountPublicJwk,
    accountPrivateKey: accountPair.privateKey,
    delegatePrivateKey: delegatePair.privateKey,
    encryptionPublicJwk,
  };
};

const createVerificationEnvironment = (
  accountPublicJwk: JsonWebKey,
  encryptionRecipient?: { encryptionKid: string; encryptionPublicJwk: JsonWebKey },
) => {
  const credential = {
    credential_id: credentialId,
    account_id: "account_a",
    expires_at: Date.now() + 60_000,
    revoked_at: null,
  };
  const prepare = jest.fn((sql: string) => {
    const statement = {
      bind: jest.fn(),
      first: jest.fn().mockResolvedValue(
        sql.includes("FROM accounts")
          ? {
              account_id: "account_a",
              signing_public_jwk: JSON.stringify(accountPublicJwk),
              encryption_kid: encryptionRecipient?.encryptionKid ?? null,
              encryption_public_jwk: encryptionRecipient
                ? JSON.stringify(encryptionRecipient.encryptionPublicJwk)
                : null,
              created_at: 1,
              updated_at: 1,
            }
          : credential,
      ),
      run: jest.fn().mockResolvedValue({ success: true }),
    };
    statement.bind.mockReturnValue(statement);
    return statement;
  });
  return {
    DB: { prepare },
    env: {
      R2_BUCKET: { get: jest.fn() },
      DB: { prepare },
      ACCOUNT_AUTH_SECRET: "test-secret",
    },
  };
};

describe("account-library repository", () => {
  it("uses an immutable keyset watermark without OFFSET and retains tombstones", async () => {
    const db = createDatabase();

    const page = await listAccountLibraryEntries(
      db as never,
      ["account_a"],
      2,
      null,
    );

    expect(db.prepare.mock.calls[0]?.[0]).toContain("entry_seq <= ? AND entry_seq < ?");
    expect(db.prepare.mock.calls[0]?.[0]).not.toContain("OFFSET");
    expect(db.bind).toHaveBeenCalledWith(
      "account_a",
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
      3,
    );
    expect(page.items).toEqual([
      {
        state: "active",
        id: "drop_new",
        visibility: "private",
        createdAt: 1,
        updatedAt: 4,
      },
      { state: "deleted", id: "drop_deleted", deletedAt: 6 },
    ]);
    expect(page.cursor).toEqual({ watermark: 12, beforeSeq: 11 });
  });

  it("preserves original creation time on upsert and writes deletion as a tombstone", async () => {
    const db = createDatabase();

    await upsertAccountLibraryEntry(db as never, {
      dropId: "drop_a",
      accountId: "account_a",
      visibility: "private",
      createdAt: 1,
      updatedAt: 2,
    });
    await tombstoneAccountLibraryEntry(db as never, "drop_a", 3);

    expect(db.prepare.mock.calls[0]?.[0]).not.toContain("created_at = excluded.created_at");
    expect(db.prepare.mock.calls[1]?.[0]).toContain("SET deleted_at = ?, updated_at = ?");
    expect(db.bind).toHaveBeenLastCalledWith(3, 3, "drop_a");
  });

  it("never transfers an existing drop projection to a different account", async () => {
    const db = createDatabase();

    await upsertAccountLibraryEntry(db as never, {
      dropId: "drop_a",
      accountId: "account_b",
      visibility: "private",
      createdAt: 1,
      updatedAt: 2,
    });

    const statement = db.prepare.mock.calls[0]?.[0] as string;
    expect(statement).not.toMatch(/DO UPDATE SET\s+account_id = excluded\.account_id/);
    expect(statement).toContain(
      "WHERE account_library_entries.account_id = excluded.account_id",
    );
  });

  it("rejects a forged account signature on a delegated signer certificate", async () => {
    const accountPair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const accountPublicJwk = await crypto.subtle.exportKey("jwk", accountPair.publicKey);
    const delegation: DropDeviceDelegation = {
      schema: "nulldown.drop-device-delegation.v1",
      version: 1,
      accountId: "account_a",
      credentialId: "credential_a",
      delegateSigningPublicJwk: {
        kty: "EC",
        crv: "P-256",
        x: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        y: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      },
      encryptionKid: "enc_a",
      encryptionPublicJwk: { kty: "RSA", n: "encryption_n", e: "AQAB" },
      issuedAt: 1,
      expiresAt: Date.now() + 60_000,
      signature: { kid: "account_a", alg: "ECDSA_P256_SHA256", sig: "placeholder" },
    };
    delegation.signature.sig = toBase64Url(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        accountPair.privateKey,
        new TextEncoder().encode(
          serializeDropDeviceDelegationForSignature(
            toDropDeviceDelegationSignable(delegation),
          ),
        ),
      ),
    );

    await expect(
      verifyDropDeviceDelegationSignature(delegation, accountPublicJwk),
    ).resolves.toBe(true);
    await expect(
      verifyDropDeviceDelegationSignature(
        { ...delegation, signature: { ...delegation.signature, sig: `${delegation.signature.sig}A` } },
        accountPublicJwk,
      ),
    ).resolves.toBe(false);
  });

  it("projects a full-JWK delegated envelope against a canonical recipient pin and requires its credential claim", async () => {
    const { envelope, accountPublicJwk, encryptionPublicJwk } = await signDelegatedEnvelope();
    const { DB, env } = createVerificationEnvironment(accountPublicJwk, {
      encryptionKid: "enc_a",
      encryptionPublicJwk,
    });
    const withClaim = await issueAccountSessionToken("account_a", env, {
      credentialId,
    });
    const generic = await issueAccountSessionToken("account_a", env);
    const mismatched = await issueAccountSessionToken("account_a", env, {
      credentialId: "B".repeat(22),
    });
    const requestFor = (token: string) => ({
      headers: new Headers({ Authorization: `Bearer ${token}` }),
    });

    expect(envelope.deviceDelegation?.encryptionPublicJwk).toEqual(
      expect.objectContaining({
        ...encryptionPublicJwk,
        alg: "RSA-OAEP-256",
        ext: true,
        key_ops: ["encrypt"],
      }),
    );
    await expect(
      verifyAccountLibraryEnvelopeOwnership(env, envelope, "account_a", credentialId),
    ).resolves.toEqual({ accountId: "account_a", reason: null });
    await expect(
      verifyAccountLibraryEnvelope(requestFor(withClaim.token), env, envelope),
    ).resolves.toBe("account_a");
    await expect(
      verifyAccountLibraryEnvelope(requestFor(generic.token), env, envelope),
    ).rejects.toEqual(expect.objectContaining<AccountLibraryError>({ code: "credential_claim_required" }));
    await expect(
      verifyAccountLibraryEnvelope(requestFor(mismatched.token), env, envelope),
    ).rejects.toEqual(expect.objectContaining<AccountLibraryError>({ code: "credential_claim_required" }));
    await projectAccountLibraryEnvelope(DB as never, "delegated_drop", "account_a", envelope, 1);
    expect(DB.prepare).toHaveBeenCalledWith(expect.stringContaining("account_library_entries"));
  });

  it("rejects a delegated envelope when the account recipient pin is missing", async () => {
    const { envelope, accountPublicJwk } = await signDelegatedEnvelope();
    const { env } = createVerificationEnvironment(accountPublicJwk);
    const session = await issueAccountSessionToken("account_a", env, { credentialId });

    await expect(
      verifyAccountLibraryEnvelope(
        { headers: new Headers({ Authorization: `Bearer ${session.token}` }) },
        env,
        envelope,
      ),
    ).rejects.toEqual(expect.objectContaining<AccountLibraryError>({ code: "untrusted_device_signature" }));
  });

  it("rejects a delegated envelope whose signed recipient JWK differs from the account pin", async () => {
    const {
      envelope,
      accountPublicJwk,
      accountPrivateKey,
      delegatePrivateKey,
      encryptionPublicJwk,
    } = await signDelegatedEnvelope();
    const { env } = createVerificationEnvironment(accountPublicJwk, {
      encryptionKid: "enc_a",
      encryptionPublicJwk,
    });
    const delegation = envelope.deviceDelegation!;
    delegation.encryptionPublicJwk = {
      kty: "RSA",
      n: "A".repeat(342),
      e: "AQAB",
    };
    await signDelegation(delegation, accountPrivateKey);
    await signEnvelope(envelope, delegatePrivateKey);
    const session = await issueAccountSessionToken("account_a", env, { credentialId });

    await expect(
      verifyAccountLibraryEnvelope(
        { headers: new Headers({ Authorization: `Bearer ${session.token}` }) },
        env,
        envelope,
      ),
    ).rejects.toEqual(expect.objectContaining<AccountLibraryError>({ code: "untrusted_device_signature" }));
  });

  it("rejects a delegated envelope whose recipient kid differs from the account pin", async () => {
    const {
      envelope,
      accountPublicJwk,
      accountPrivateKey,
      delegatePrivateKey,
      encryptionPublicJwk,
    } = await signDelegatedEnvelope();
    const { env } = createVerificationEnvironment(accountPublicJwk, {
      encryptionKid: "enc_a",
      encryptionPublicJwk,
    });
    const delegation = envelope.deviceDelegation!;
    delegation.encryptionKid = "enc_b";
    envelope.keyEnvelope.kid = "enc_b";
    await signDelegation(delegation, accountPrivateKey);
    await signEnvelope(envelope, delegatePrivateKey);
    const session = await issueAccountSessionToken("account_a", env, { credentialId });

    await expect(
      verifyAccountLibraryEnvelope(
        { headers: new Headers({ Authorization: `Bearer ${session.token}` }) },
        env,
        envelope,
      ),
    ).rejects.toEqual(expect.objectContaining<AccountLibraryError>({ code: "untrusted_device_signature" }));
  });

  it("accepts an old direct browser envelope when the account has no recipient pin", async () => {
    const { envelope, accountPublicJwk, accountPrivateKey } = await signDelegatedEnvelope();
    delete envelope.deviceDelegation;
    envelope.deviceSignerPublicJwk = accountPublicJwk;
    await signEnvelope(envelope, accountPrivateKey);
    const { env } = createVerificationEnvironment(accountPublicJwk);
    const session = await issueAccountSessionToken("account_a", env);

    await expect(
      verifyAccountLibraryEnvelope(
        { headers: new Headers({ Authorization: `Bearer ${session.token}` }) },
        env,
        envelope,
      ),
    ).resolves.toBe("account_a");
  });
});

import type {
  BlobObjectStore,
  SqlMetadataStore,
} from "../../../../../src/server/ports";
import { serializeCanonicalJson } from "../../../../../shared/drop/types";
import {
  isAccountRecord,
  type AccountEncryptionRecipient,
  type AccountRecordV1,
} from "./records";

/** R2 prefix for persisted account authentication records. */
export const ACCOUNT_RECORD_PREFIX = "__account_auth__/accounts/";

const accountRecordKey = (accountId: string) =>
  `${ACCOUNT_RECORD_PREFIX}${accountId}.json`;

const samePublicSigningKey = (left: JsonWebKey, right: JsonWebKey): boolean =>
  left.kty === right.kty &&
  left.crv === right.crv &&
  left.x === right.x &&
  left.y === right.y;

const sameAccountEncryptionRecipient = (
  left: AccountEncryptionRecipient | undefined,
  right: AccountEncryptionRecipient | undefined,
): boolean => {
  if (!left || !right) return false;
  return (
    left.encryptionKid === right.encryptionKid &&
    serializeCanonicalJson(left.encryptionPublicJwk) ===
      serializeCanonicalJson(right.encryptionPublicJwk)
  );
};

/** Reads a persisted account record by account id. */
export const readAccountRecord = async (
  bucket: BlobObjectStore | undefined,
  accountId: string,
  db?: SqlMetadataStore,
): Promise<AccountRecordV1 | null> => {
  if (db) {
    const row = await db
      .prepare(
        `SELECT account_id, signing_public_jwk, encryption_kid, encryption_public_jwk, created_at, updated_at
         FROM accounts
         WHERE account_id = ?`,
      )
      .bind(accountId)
      .first<{
        account_id: string;
        signing_public_jwk: string;
        encryption_kid?: string | null;
        encryption_public_jwk?: string | null;
        created_at: number;
        updated_at: number;
      }>();
    if (row) {
      try {
        const signingPublicJwk = JSON.parse(row.signing_public_jwk) as unknown;
        const record = {
          version: 1 as const,
          accountId: row.account_id,
          signingPublicJwk,
          ...(row.encryption_kid && row.encryption_public_jwk
            ? {
                encryptionKid: row.encryption_kid,
                encryptionPublicJwk: JSON.parse(
                  row.encryption_public_jwk,
                ) as unknown,
              }
            : {}),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        };
        if (isAccountRecord(record)) return record;
      } catch {
        // A corrupt D1 projection must not hide a valid R2 account record.
      }
    }
  }

  if (!bucket) return null;
  const object = await bucket.get(accountRecordKey(accountId));
  if (!object?.body) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = await object.json<unknown>();
  } catch {
    return null;
  }

  const record = isAccountRecord(parsed) ? parsed : null;
  if (record && db) {
    await putAccountRecord(bucket, record, db);
  }
  return record;
};

/** Writes the current account signing record to D1 and R2 fallback storage. */
export const putAccountRecord = async (
  bucket: BlobObjectStore,
  record: AccountRecordV1,
  db?: SqlMetadataStore,
): Promise<void> => {
  if (db) {
    await db
      .prepare(
        `INSERT INTO accounts (account_id, signing_public_jwk, encryption_kid, encryption_public_jwk, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(account_id) DO UPDATE SET
            signing_public_jwk = excluded.signing_public_jwk,
            encryption_kid = excluded.encryption_kid,
            encryption_public_jwk = excluded.encryption_public_jwk,
            updated_at = excluded.updated_at`,
      )
      .bind(
        record.accountId,
        JSON.stringify(record.signingPublicJwk),
        record.encryptionKid ?? null,
        record.encryptionPublicJwk
          ? JSON.stringify(record.encryptionPublicJwk)
          : null,
        record.createdAt,
        record.updatedAt,
      )
      .run();
  }
  await bucket.put(accountRecordKey(record.accountId), JSON.stringify(record), {
    httpMetadata: { contentType: "application/json" },
  });
};

/** Reserves an account's first signing key without allowing replacement. */
export const reserveAccountRecord = async (
  bucket: BlobObjectStore,
  record: AccountRecordV1,
  db?: SqlMetadataStore,
): Promise<AccountRecordV1 | null> => {
  if (db) {
    await db
      .prepare(
        `INSERT INTO accounts (account_id, signing_public_jwk, encryption_kid, encryption_public_jwk, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id) DO NOTHING`,
      )
      .bind(
        record.accountId,
        JSON.stringify(record.signingPublicJwk),
        record.encryptionKid ?? null,
        record.encryptionPublicJwk
          ? JSON.stringify(record.encryptionPublicJwk)
          : null,
        record.createdAt,
        record.updatedAt,
      )
      .run();

    const persisted = await readAccountRecord(bucket, record.accountId, db);
    if (
      !persisted ||
      !samePublicSigningKey(persisted.signingPublicJwk, record.signingPublicJwk)
    ) {
      return persisted;
    }

    await bucket.put(
      accountRecordKey(record.accountId),
      JSON.stringify(persisted),
      {
        httpMetadata: { contentType: "application/json" },
      },
    );
    return persisted;
  }

  const created = await bucket.put(
    accountRecordKey(record.accountId),
    JSON.stringify(record),
    {
      httpMetadata: { contentType: "application/json" },
      onlyIf: { etagDoesNotMatch: "*" },
    },
  );
  if (created) {
    return record;
  }

  return readAccountRecord(bucket, record.accountId);
};

/** Pins an account encryption recipient without allowing later replacement. */
export const pinAccountEncryptionRecipient = async (
  bucket: BlobObjectStore,
  record: AccountRecordV1,
  recipient: AccountEncryptionRecipient,
  db?: SqlMetadataStore,
): Promise<AccountRecordV1 | null> => {
  const existingRecipient = record.encryptionKid
    ? {
        encryptionKid: record.encryptionKid,
        encryptionPublicJwk: record.encryptionPublicJwk as JsonWebKey,
      }
    : undefined;
  if (existingRecipient) {
    return sameAccountEncryptionRecipient(existingRecipient, recipient)
      ? record
      : null;
  }

  const updated = {
    ...record,
    ...recipient,
    updatedAt: Date.now(),
  };
  if (!db) {
    await bucket.put(
      accountRecordKey(record.accountId),
      JSON.stringify(updated),
      {
        httpMetadata: { contentType: "application/json" },
      },
    );
    return updated;
  }

  await db
    .prepare(
      `UPDATE accounts
       SET encryption_kid = ?, encryption_public_jwk = ?, updated_at = ?
       WHERE account_id = ?
         AND encryption_kid IS NULL
         AND encryption_public_jwk IS NULL`,
    )
    .bind(
      recipient.encryptionKid,
      JSON.stringify(recipient.encryptionPublicJwk),
      updated.updatedAt,
      record.accountId,
    )
    .run();
  const persisted = await readAccountRecord(bucket, record.accountId, db);
  if (!persisted) return null;
  await bucket.put(
    accountRecordKey(record.accountId),
    JSON.stringify(persisted),
    {
      httpMetadata: { contentType: "application/json" },
    },
  );
  return sameAccountEncryptionRecipient(
    persisted.encryptionKid
      ? {
          encryptionKid: persisted.encryptionKid,
          encryptionPublicJwk: persisted.encryptionPublicJwk as JsonWebKey,
        }
      : undefined,
    recipient,
  )
    ? persisted
    : null;
};

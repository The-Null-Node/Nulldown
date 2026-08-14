import type { VoidBlobStore, VoidSqlStore } from "../../../../../src/server/ports";
import { DROP_ID_LENGTH, generateDropId } from "../../../../../shared/drop/id";
import { syncPublicDropIndexForPayload } from "../index/repository";
import { createDropIdentityRepository } from "../identity/id";
import { createDropObjectRepository } from "./objectRepository";

const MAX_ID_ALLOCATION_ATTEMPTS = 64;

/** Allocates a remote drop id and stores a JSON payload under that id. */
export const createRemoteJsonDrop = async (
  bucket: VoidBlobStore,
  payload: object,
  db?: VoidSqlStore,
): Promise<string> => {
  const storedPayload = JSON.stringify(payload);
  const dropRepository = createDropObjectRepository({ blobs: bucket, sql: db });
  const dropIdentityRepository = createDropIdentityRepository({
    blobs: bucket,
    sql: db,
  });

  for (let attempt = 0; attempt < MAX_ID_ALLOCATION_ATTEMPTS; attempt += 1) {
    const candidateId = generateDropId(DROP_ID_LENGTH);
    const aliasState = await dropIdentityRepository.reserveRemoteAlias(candidateId);
    if (aliasState === "conflict") {
      continue;
    }

    let storedSuccessfully = false;

    try {
      const stored = await dropRepository.put(candidateId, storedPayload, {
        contentType: "application/json",
      });
      if (stored === "stored") {
        storedSuccessfully = true;
        await syncPublicDropIndexForPayload(bucket, candidateId, payload, Date.now(), db);
        return candidateId;
      }
    } finally {
      if (!storedSuccessfully && aliasState === "reserved") {
        await dropIdentityRepository.removeRemoteAliasIfMatch(candidateId);
      }
    }
  }

  throw new Error("Unable to allocate a unique remote drop id.");
};

/** Reserves a unique drop id before a separate durable workflow records it. */
export const reserveRemoteJsonDropId = async (
  bucket: VoidBlobStore,
  db?: VoidSqlStore,
): Promise<string> => {
  const dropIdentityRepository = createDropIdentityRepository({
    blobs: bucket,
    sql: db,
  });

  for (let attempt = 0; attempt < MAX_ID_ALLOCATION_ATTEMPTS; attempt += 1) {
    const candidateId = generateDropId(DROP_ID_LENGTH);
    if ((await dropIdentityRepository.reserveRemoteAlias(candidateId)) === "reserved") {
      return candidateId;
    }
  }

  throw new Error("Unable to reserve a unique remote drop id.");
};

/** Releases an unused remote id reservation after its owning workflow fails before persistence. */
export const releaseReservedRemoteJsonDropId = async (
  bucket: VoidBlobStore,
  id: string,
  db?: VoidSqlStore,
): Promise<void> => {
  const dropIdentityRepository = createDropIdentityRepository({
    blobs: bucket,
    sql: db,
  });
  await dropIdentityRepository.removeRemoteAliasIfMatch(id);
};

/** Stores a payload at a previously reserved id, accepting only an exact retry match. */
export const createReservedRemoteJsonDrop = async (
  bucket: VoidBlobStore,
  id: string,
  payload: object,
  db?: VoidSqlStore,
): Promise<"stored" | "existing"> => {
  const dropIdentityRepository = createDropIdentityRepository({
    blobs: bucket,
    sql: db,
  });
  const aliasState = await dropIdentityRepository.reserveRemoteAlias(id);
  if (aliasState === "conflict") {
    throw new Error("promotion_target_alias_conflict");
  }
  const storedPayload = JSON.stringify(payload);
  const dropRepository = createDropObjectRepository({ blobs: bucket, sql: db });
  const stored = await dropRepository.put(id, storedPayload, {
    contentType: "application/json",
  });

  if (stored === "stored") {
    await syncPublicDropIndexForPayload(bucket, id, payload, Date.now(), db);
    return "stored";
  }

  const existing = await bucket.get(id);
  if (!existing || (await existing.text()) !== storedPayload) {
    throw new Error("promotion_target_integrity_mismatch");
  }

  await syncPublicDropIndexForPayload(bucket, id, payload, Date.now(), db);
  return "existing";
};

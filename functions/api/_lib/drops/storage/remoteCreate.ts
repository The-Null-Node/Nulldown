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

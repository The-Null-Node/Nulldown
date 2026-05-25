import type { R2Bucket } from "@cloudflare/workers-types";
import { DROP_ID_LENGTH, generateDropId } from "../../../shared/drop/id";
import { syncPublicDropIndexForPayload } from "./dropIndex";
import { removeRemoteAliasIfMatch, reserveRemoteAlias } from "./dropId";
import { R2DropObjectRepository } from "./dropObjectRepository";

const MAX_ID_ALLOCATION_ATTEMPTS = 64;

export const createRemoteJsonDrop = async (
  bucket: R2Bucket,
  payload: object,
): Promise<string> => {
  const storedPayload = JSON.stringify(payload);
  const dropRepository = new R2DropObjectRepository(bucket);

  for (let attempt = 0; attempt < MAX_ID_ALLOCATION_ATTEMPTS; attempt += 1) {
    const candidateId = generateDropId(DROP_ID_LENGTH);
    const aliasState = await reserveRemoteAlias(bucket, candidateId);
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
        await syncPublicDropIndexForPayload(bucket, candidateId, payload);
        return candidateId;
      }
    } finally {
      if (!storedSuccessfully && aliasState === "reserved") {
        await removeRemoteAliasIfMatch(bucket, candidateId);
      }
    }
  }

  throw new Error("Unable to allocate a unique remote drop id.");
};

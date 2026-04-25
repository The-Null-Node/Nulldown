import type { R2Bucket } from "@cloudflare/workers-types";
import { DROP_ID_LENGTH, generateDropId } from "../../../shared/drop/id";
import { removeRemoteAliasIfMatch, reserveRemoteAlias } from "./dropId";

const MAX_ID_ALLOCATION_ATTEMPTS = 64;

const putDropObject = async (
  bucket: R2Bucket,
  id: string,
  payload: string,
  contentType: string,
): Promise<boolean> => {
  const created = await bucket.put(id, payload, {
    onlyIf: {
      etagDoesNotMatch: "*",
    },
    httpMetadata: { contentType },
  });

  return Boolean(created);
};

export const createRemoteJsonDrop = async (
  bucket: R2Bucket,
  payload: unknown,
): Promise<string> => {
  const storedPayload = JSON.stringify(payload);

  for (let attempt = 0; attempt < MAX_ID_ALLOCATION_ATTEMPTS; attempt += 1) {
    const candidateId = generateDropId(DROP_ID_LENGTH);
    const aliasState = await reserveRemoteAlias(bucket, candidateId);
    if (aliasState === "conflict") {
      continue;
    }

    try {
      const stored = await putDropObject(
        bucket,
        candidateId,
        storedPayload,
        "application/json",
      );
      if (stored) {
        return candidateId;
      }
    } finally {
      const object = await bucket.get(candidateId);
      if (!object && aliasState === "reserved") {
        await removeRemoteAliasIfMatch(bucket, candidateId);
      }
    }
  }

  throw new Error("Unable to allocate a unique remote drop id.");
};

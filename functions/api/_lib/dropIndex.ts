import type { R2Bucket, R2ObjectBody } from "@cloudflare/workers-types";
import {
  isDropEnvelopeV1,
  type DropEnvelopeV1,
} from "../../../shared/drop/types";

export const REMOTE_PUBLIC_DROP_INDEX_PREFIX = "__drop_public_index__/";

const INDEX_CONTENT_TYPE = "application/json";

export interface DropPublicIndexEntry {
  version: 1;
  id: string;
  createdAt: number;
  updatedAt: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isDropPublicIndexEntry = (
  value: unknown,
): value is DropPublicIndexEntry => {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.version === 1 &&
    typeof value.id === "string" &&
    typeof value.createdAt === "number" &&
    Number.isFinite(value.createdAt) &&
    typeof value.updatedAt === "number" &&
    Number.isFinite(value.updatedAt)
  );
};

export const createRemotePublicDropIndexKey = (id: string): string =>
  `${REMOTE_PUBLIC_DROP_INDEX_PREFIX}${id}.json`;

export const isRemotePublicDropIndexKey = (key: string): boolean =>
  key.startsWith(REMOTE_PUBLIC_DROP_INDEX_PREFIX);

const parsePublicIndexEntryFromObject = async (
  object: R2ObjectBody | null,
): Promise<DropPublicIndexEntry | null> => {
  if (!object?.body) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = await Response(object.body).json();
  } catch {
    return null;
  }

  return isDropPublicIndexEntry(parsed) ? parsed : null;
};

export const readPublicDropIndexEntry = async (
  bucket: R2Bucket,
  id: string,
): Promise<DropPublicIndexEntry | null> => {
  const key = createRemotePublicDropIndexKey(id);
  const object = await bucket.get(key);
  return parsePublicIndexEntryFromObject(object);
};

export const readPublicDropIndexEntryByKey = async (
  bucket: R2Bucket,
  key: string,
): Promise<DropPublicIndexEntry | null> => {
  const object = await bucket.get(key);
  return parsePublicIndexEntryFromObject(object);
};

export const upsertPublicDropIndexEntry = async (
  bucket: R2Bucket,
  id: string,
  updatedAt = Date.now(),
): Promise<DropPublicIndexEntry> => {
  const existing = await readPublicDropIndexEntry(bucket, id);
  const entry: DropPublicIndexEntry = {
    version: 1,
    id,
    createdAt: existing?.createdAt ?? updatedAt,
    updatedAt,
  };

  await bucket.put(createRemotePublicDropIndexKey(id), JSON.stringify(entry), {
    httpMetadata: { contentType: INDEX_CONTENT_TYPE },
  });

  return entry;
};

export const removePublicDropIndexEntry = async (
  bucket: R2Bucket,
  id: string,
): Promise<void> => {
  await bucket.delete(createRemotePublicDropIndexKey(id));
};

export const syncPublicDropIndexForEnvelope = async (
  bucket: R2Bucket,
  id: string,
  envelope: DropEnvelopeV1 | null,
  updatedAt = Date.now(),
): Promise<void> => {
  if (envelope && (envelope.visibility ?? "unlisted") === "public") {
    await upsertPublicDropIndexEntry(bucket, id, updatedAt);
    return;
  }

  await removePublicDropIndexEntry(bucket, id);
};

export const syncPublicDropIndexForPayload = async (
  bucket: R2Bucket,
  id: string,
  payload: unknown,
  updatedAt = Date.now(),
): Promise<void> => {
  if (isDropEnvelopeV1(payload)) {
    await syncPublicDropIndexForEnvelope(bucket, id, payload, updatedAt);
    return;
  }

  await removePublicDropIndexEntry(bucket, id);
};

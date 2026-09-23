import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import type {
  BlobObjectStore,
  SqlMetadataStore,
} from "../../../../../../src/server/ports";

/** Cloudflare bindings used by backend services through portable ports. */
export interface CloudflareStorageBindings {
  R2_BUCKET: R2Bucket;
  DB?: D1Database;
}

/** Exposes a Cloudflare R2 bucket through the portable blob-store port. */
export const createCloudflareBlobStore = (bucket: R2Bucket): BlobObjectStore =>
  bucket as unknown as BlobObjectStore;

/** Exposes a Cloudflare D1 database through the portable SQL-store port. */
export const createCloudflareSqlStore = (
  db: D1Database | undefined,
): SqlMetadataStore | undefined =>
  db as unknown as SqlMetadataStore | undefined;

/** Converts Cloudflare storage bindings into portable service ports. */
export const createCloudflareStorageServiceEnv = <
  TBindings extends { R2_BUCKET: R2Bucket; DB?: D1Database },
>(
  bindings: TBindings,
): Omit<TBindings, "R2_BUCKET" | "DB"> & {
  R2_BUCKET: BlobObjectStore;
  DB?: SqlMetadataStore;
} => ({
  ...bindings,
  R2_BUCKET: createCloudflareBlobStore(bindings.R2_BUCKET),
  DB: createCloudflareSqlStore(bindings.DB),
});

import type {
  BlobObjectStore,
  SqlMetadataStore,
} from "../../../../../../src/server/ports";

/** Environment required by D1 metadata backfill. */
export interface MetadataBackfillEnv {
  R2_BUCKET: BlobObjectStore;
  DB?: SqlMetadataStore;
  METADATA_BACKFILL_TOKEN?: string;
  DROP_INDEX_BACKFILL_TOKEN?: string;
}

/** Counters returned by the D1 metadata backfill job. */
export interface MetadataBackfillStats {
  scanned: number;
  skipped: number;
  invalid: number;
  failed: number;
  aliasesUpserted: number;
  dropsUpserted: number;
  publicIndexUpserted: number;
  publicIndexRemoved: number;
  accountsUpserted: number;
  branchesUpserted: number;
  writerPointersUpserted: number;
  snapshotsUpserted: number;
  eventsUpserted: number;
  diffCredentialsUpserted: number;
  nullplugFactsUpserted: number;
  resolvedHeapsUpserted: number;
  searchIndexUpserted: number;
  accountLibraryUpserted: number;
  accountLibrarySkipped: Record<string, number>;
}

/** Creates zeroed counters for one metadata backfill page. */
export const createMetadataBackfillStats = (): MetadataBackfillStats => ({
  scanned: 0,
  skipped: 0,
  invalid: 0,
  failed: 0,
  aliasesUpserted: 0,
  dropsUpserted: 0,
  publicIndexUpserted: 0,
  publicIndexRemoved: 0,
  accountsUpserted: 0,
  branchesUpserted: 0,
  writerPointersUpserted: 0,
  snapshotsUpserted: 0,
  eventsUpserted: 0,
  diffCredentialsUpserted: 0,
  nullplugFactsUpserted: 0,
  resolvedHeapsUpserted: 0,
  searchIndexUpserted: 0,
  accountLibraryUpserted: 0,
  accountLibrarySkipped: {},
});

/** Records a classified account-library omission in aggregate backfill stats. */
export const skipAccountLibraryEntry = (
  stats: MetadataBackfillStats,
  reason: string,
): void => {
  stats.skipped += 1;
  stats.accountLibrarySkipped[reason] =
    (stats.accountLibrarySkipped[reason] ?? 0) + 1;
};

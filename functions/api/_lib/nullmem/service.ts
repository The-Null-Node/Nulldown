import type {
  BlobObjectStore,
  RuntimeDataStore,
  SqlMetadataStore,
} from "../../../../src/server/ports";
import type { BranchMemoryService } from "../../../../src/server/runtime";
import { createNullMemCatalogSource } from "./catalog";
import { createNullMemFreshnessService } from "./freshness";
import { createNullMemMutationService } from "./mutation";
import { createNullMemQuery } from "./query";
import { createNullMemRepository } from "./repository";
import type { LegacySourceWriter } from "../../../../src/server/state-plane/legacy-source-writer";

/** Dependencies required to compose the branch-scoped NullMem service. */
export interface CreateNullMemServiceOptions {
  /** Explicit source-generation admission for legacy memory mutations. */
  sourceWriter?: LegacySourceWriter;
  /** Blob store used to read optional capability source catalogs. */
  blobs: BlobObjectStore;
  /** SQL metadata store used to read and write memory records. */
  sql?: SqlMetadataStore;
  /** Data store used for derived freshness watermarks. */
  data?: RuntimeDataStore;
}

/** Application service that orchestrates NullMem records, catalogs, and freshness. */
export type NullMemApplicationService = BranchMemoryService;

/** Creates the branch-scoped NullMem service from platform storage ports. */
export const createNullMemService = ({
  blobs,
  sql,
  data,
  sourceWriter,
}: CreateNullMemServiceOptions): NullMemApplicationService => {
  const repository = createNullMemRepository({ sql });
  const catalog = createNullMemCatalogSource({ blobs });
  const freshness = createNullMemFreshnessService({ blobs, sql, data });
  const query = createNullMemQuery({ repository, catalog, freshness });
  const mutations = createNullMemMutationService(repository);

  return {
    query: async (request) => {
      if (!sql) {
        throw new Error("SQL metadata store is required to query memory.");
      }
      return query(request);
    },
    createFact: async (request) => {
      if (!sql) {
        throw new Error(
          "SQL metadata store is required to create memory facts.",
        );
      }
      return sourceWriter
        ? sourceWriter.run(request, "memory", () =>
            mutations.createFact(request),
          )
        : mutations.createFact(request);
    },
    createProcedure: async (request) => {
      if (!sql) {
        throw new Error(
          "SQL metadata store is required to create memory procedures.",
        );
      }
      return sourceWriter
        ? sourceWriter.run(request, "memory", () =>
            mutations.createProcedure(request),
          )
        : mutations.createProcedure(request);
    },
    delete: async (request) => {
      if (!sql) {
        throw new Error(
          "SQL metadata store is required to delete memory records.",
        );
      }
      return sourceWriter
        ? sourceWriter.run(request, "memory", () => mutations.delete(request))
        : mutations.delete(request);
    },
  };
};

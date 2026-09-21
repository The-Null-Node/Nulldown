import type {
  RuntimeDataIndexEntry,
  RuntimeDataIndexFilter,
  RuntimeDataKey,
  RuntimeDataListItem,
  RuntimeDataListQuery,
  RuntimeDataListResult,
  RuntimeDataPutOptions,
  RuntimeDataPutRecord,
  RuntimeDataQuery,
  RuntimeDataStore,
} from "../../../../../../../src/server/ports";
import type { CloudflareStorageBindings } from "../storage";
import { createCloudflareBlobStore } from "../storage";
import { withCloudflareRuntimeDataLock } from "./lock";
import { createCloudflareRuntimeDataRepository } from "./repository";

const indexValueMatches = (
  actual: RuntimeDataIndexEntry["value"],
  expected: RuntimeDataIndexEntry["value"],
): boolean => {
  const actualValues = Array.isArray(actual) ? actual : [actual];
  const expectedValues = Array.isArray(expected) ? expected : [expected];
  return expectedValues.some((expectedValue) =>
    actualValues.includes(expectedValue),
  );
};

const matchesIndexFilter = (
  indexes: RuntimeDataIndexEntry[] | undefined,
  filter: RuntimeDataIndexFilter,
): boolean => {
  const matches = indexes?.filter((entry) => entry.name === filter.name) ?? [];
  if (!matches.length) return false;

  if (filter.value !== undefined) {
    const expected = filter.value;
    return matches.some((entry) => indexValueMatches(entry.value, expected));
  }

  if (filter.values !== undefined) {
    return matches.some((entry) =>
      filter.values?.some((value) => indexValueMatches(entry.value, value)),
    );
  }

  return true;
};

const matchesTextQuery = <T>(
  item: RuntimeDataListItem<T>,
  text: string | undefined,
): boolean => {
  const query = text?.trim().toLowerCase();
  if (!query) return true;
  const indexedText = item.indexes
    ?.filter((entry) => entry.mode === "fulltext" || entry.name === "text")
    .map((entry) => String(entry.value))
    .join("\n");
  const searchable = indexedText || JSON.stringify(item.value);
  return searchable.toLowerCase().includes(query);
};

/** Creates the Cloudflare implementation of the generic runtime-data port. */
export const createCloudflareRuntimeDataStore = ({
  R2_BUCKET,
  DB,
}: CloudflareStorageBindings): RuntimeDataStore => {
  const blobs = createCloudflareBlobStore(R2_BUCKET);
  const repository = createCloudflareRuntimeDataRepository(DB);

  const putMany = async (records: RuntimeDataPutRecord[]): Promise<void> => {
    await repository.putMany(records);
  };

  const dataStore: RuntimeDataStore = {
    get: <T = unknown>(key: RuntimeDataKey) => repository.get<T>(key),
    put: async <T = unknown>(
      key: RuntimeDataKey,
      value: T,
      options?: RuntimeDataPutOptions,
    ): Promise<void> => {
      await putMany([{ key, value, options }]);
    },
    putMany,
    delete: (key) => repository.delete(key),
    list: <T = unknown>(
      query: RuntimeDataListQuery,
    ): Promise<RuntimeDataListResult<T>> => repository.list<T>(query),
    query: async <T = unknown>(query: RuntimeDataQuery): Promise<T[]> => {
      const listed = await repository.list<T>(query);
      return listed.items
        .filter((item) =>
          (query.indexes ?? []).every((filter) =>
            matchesIndexFilter(item.indexes, filter),
          ),
        )
        .filter((item) => matchesTextQuery(item, query.text))
        .map((item) => item.value);
    },
    tx: async <T>(work: (data: RuntimeDataStore) => Promise<T>): Promise<T> =>
      work(dataStore),
    lock: (key, work) =>
      withCloudflareRuntimeDataLock(blobs, dataStore, key, work),
  };

  return dataStore;
};

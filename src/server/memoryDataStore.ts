import type {
  VoidDataIndexEntry,
  VoidDataIndexFilter,
  VoidDataKey,
  VoidDataListItem,
  VoidDataListQuery,
  VoidDataListResult,
  VoidDataPrimitive,
  VoidDataPutOptions,
  VoidDataQuery,
  VoidDataScope,
  VoidDataStore,
} from "./ports";

interface MemoryRecord<T = unknown> {
  key: VoidDataKey;
  value: T;
  indexes?: VoidDataIndexEntry[];
  updatedAt: number;
}

const scopeEntries = (scope: VoidDataScope | undefined) =>
  Object.entries(scope ?? {}).sort(([left], [right]) => left.localeCompare(right));

const scopeSegment = ([key, value]: [string, VoidDataPrimitive]): string =>
  `${encodeURIComponent(key)}=${encodeURIComponent(JSON.stringify(value))}`;

const keyScope = (scope: VoidDataScope | undefined): string =>
  scopeEntries(scope).map(scopeSegment).join("/");

const storeKey = (key: VoidDataKey): string =>
  [key.namespace, key.collection ?? "", keyScope(key.scope), key.id]
    .map((segment) => encodeURIComponent(segment))
    .join("/");

const matchesListQuery = <T>(
  item: VoidDataListItem<T>,
  query: VoidDataListQuery,
): boolean => {
  if (item.key.namespace !== query.namespace) return false;
  if (query.collection !== undefined && item.key.collection !== query.collection) {
    return false;
  }
  if (query.idPrefix && !item.key.id.startsWith(query.idPrefix)) return false;

  for (const [key, value] of scopeEntries(query.scope)) {
    if (item.key.scope?.[key] !== value) return false;
  }

  return true;
};

const indexValueMatches = (
  actual: VoidDataIndexEntry["value"],
  expected: VoidDataIndexEntry["value"],
): boolean => {
  const actualValues = Array.isArray(actual) ? actual : [actual];
  const expectedValues = Array.isArray(expected) ? expected : [expected];
  return expectedValues.some((expectedValue) => actualValues.includes(expectedValue));
};

const matchesIndexFilter = (
  indexes: VoidDataIndexEntry[] | undefined,
  filter: VoidDataIndexFilter,
): boolean => {
  const matches = indexes?.filter((entry) => entry.name === filter.name) ?? [];
  if (!matches.length) return false;
  if (filter.value !== undefined) {
    return matches.some((entry) => indexValueMatches(entry.value, filter.value));
  }
  if (filter.values !== undefined) {
    return matches.some((entry) =>
      filter.values?.some((value) => indexValueMatches(entry.value, value)),
    );
  }
  return true;
};

const matchesTextQuery = <T>(
  item: VoidDataListItem<T>,
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

const toListItem = <T>(record: MemoryRecord<T>): VoidDataListItem<T> => ({
  key: record.key,
  value: record.value,
  indexes: record.indexes,
  updatedAt: record.updatedAt,
});

/** Creates an in-memory `VoidDataStore` for portable server tests and local adapters. */
export const createMemoryVoidDataStore = (): VoidDataStore => {
  const records = new Map<string, MemoryRecord>();
  const locks = new Map<string, Promise<void>>();

  const dataStore: VoidDataStore = {
    get: async <T = unknown>(key: VoidDataKey): Promise<T | null> =>
      (records.get(storeKey(key))?.value as T | undefined) ?? null,

    put: async <T = unknown>(
      key: VoidDataKey,
      value: T,
      options?: VoidDataPutOptions,
    ): Promise<void> => {
      const id = storeKey(key);
      if (options?.ifAbsent && records.has(id)) {
        throw new Error("void_data_put_conflict");
      }
      records.set(id, {
        key,
        value,
        indexes: options?.indexes,
        updatedAt: Date.now(),
      });
    },

    delete: async (key: VoidDataKey): Promise<void> => {
      records.delete(storeKey(key));
    },

    list: async <T = unknown>(
      query: VoidDataListQuery,
    ): Promise<VoidDataListResult<T>> => {
      const limit = Math.max(1, Math.min(1000, query.limit ?? 1000));
      const offset = query.cursor ? Math.max(0, Number.parseInt(query.cursor, 10) || 0) : 0;
      const items = [...records.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, record]) => toListItem(record as MemoryRecord<T>))
        .filter((item) => matchesListQuery(item, query));
      const page = items.slice(offset, offset + limit);
      const nextOffset = offset + page.length;
      return {
        items: page,
        cursor: nextOffset < items.length ? String(nextOffset) : null,
        truncated: nextOffset < items.length,
      };
    },

    query: async <T = unknown>(query: VoidDataQuery): Promise<T[]> => {
      const listed = await dataStore.list<T>(query);
      return listed.items
        .filter((item) =>
          (query.indexes ?? []).every((filter) =>
            matchesIndexFilter(item.indexes, filter),
          ),
        )
        .filter((item) => matchesTextQuery(item, query.text))
        .map((item) => item.value);
    },

    tx: async <T>(work: (data: VoidDataStore) => Promise<T>): Promise<T> =>
      work(dataStore),

    lock: async <T>(
      key: VoidDataKey,
      work: (data: VoidDataStore) => Promise<T>,
    ): Promise<T> => {
      const id = storeKey(key);
      const previous = locks.get(id) ?? Promise.resolve();
      let release: () => void = () => {};
      const current = new Promise<void>((resolve) => {
        release = resolve;
      });
      const marker = previous.then(() => current, () => current);
      locks.set(id, marker);
      await previous.catch(() => undefined);
      try {
        return await work(dataStore);
      } finally {
        release();
        if (locks.get(id) === marker) {
          locks.delete(id);
        }
      }
    },
  };

  return dataStore;
};

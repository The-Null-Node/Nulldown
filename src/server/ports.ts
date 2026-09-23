/** Bindable scalar values accepted by the portable SQL metadata port. */
export type SqlBindableValue =
  string | number | boolean | null | ArrayBuffer | Uint8Array;

/** Result shape returned by SQL `all` queries. */
export interface SqlRows<T = Record<string, unknown>> {
  results?: T[];
}

/** Prepared-statement port shared by D1, SQLite, and test metadata stores. */
export interface SqlStatement {
  /** Binds positional values and returns the statement for execution. */
  bind(...values: SqlBindableValue[]): SqlStatement;
  /** Executes a statement that does not need row data. */
  run(): Promise<unknown>;
  /** Reads the first row from a query, or null when no row matches. */
  first<T = Record<string, unknown>>(): Promise<T | null>;
  /** Reads all rows returned by a query. */
  all<T = Record<string, unknown>>(): Promise<SqlRows<T>>;
}

/** SQL metadata store port used by the platform-neutral backend services. */
export interface SqlMetadataStore {
  /** Creates a prepared statement for a SQL query. */
  prepare(sql: string): SqlStatement;
  /** Executes a batch of prepared statements when the adapter supports it. */
  batch?(statements: SqlStatement[]): Promise<unknown[]>;
}

/** Opaque object body accepted by the portable blob store. */
export type BlobObjectBody =
  string | ArrayBuffer | ArrayBufferView | Blob | ReadableStream | null;

/** Conditional write options shared by R2 and local blob-store adapters. */
export interface BlobWriteCondition {
  etagDoesNotMatch?: string;
  etagMatches?: string;
}

/** Write options for opaque blob objects. */
export interface BlobPutOptions {
  httpMetadata?: {
    contentType?: string;
    contentLanguage?: string;
    contentDisposition?: string;
    contentEncoding?: string;
    cacheControl?: string;
    cacheExpiry?: Date;
  };
  onlyIf?: BlobWriteCondition;
}

/** Object metadata returned by blob write, head, and list operations. */
export interface BlobObjectMetadata {
  key: string;
  etag?: string;
  httpEtag?: string;
  uploaded?: Date;
  size?: number;
  httpMetadata?: {
    contentType?: string;
    contentLanguage?: string;
    contentDisposition?: string;
    contentEncoding?: string;
    cacheControl?: string;
    cacheExpiry?: Date;
  };
}

/** Full blob object returned by reads from the portable blob store. */
export interface BlobObject extends BlobObjectMetadata {
  body?: ReadableStream | null;
  /** Reads the object body as UTF-8 text. */
  text(): Promise<string>;
  /** Parses the object body as JSON. */
  json<T = unknown>(): Promise<T>;
}

/** Paged list result returned by blob store adapters. */
export interface BlobListResult {
  objects: BlobObjectMetadata[];
  truncated: boolean;
  cursor?: string;
}

/** List options for object stores that support prefix scans. */
export interface BlobListOptions {
  prefix?: string;
  cursor?: string;
  startAfter?: string;
  limit?: number;
}

/** Opaque blob/object storage port used by backend services. */
export interface BlobObjectStore {
  /** Reads a blob object by key. */
  get(key: string): Promise<BlobObject | null>;
  /** Reads object metadata by key without loading the body. */
  head(key: string): Promise<BlobObjectMetadata | null>;
  /** Writes a blob object, optionally using conditional semantics. */
  put(
    key: string,
    value: BlobObjectBody,
    options?: BlobPutOptions,
  ): Promise<BlobObjectMetadata | null>;
  /** Deletes one or more blob object keys. */
  delete(keys: string | string[]): Promise<void>;
  /** Lists blob object metadata with optional prefix pagination. */
  list(options?: BlobListOptions): Promise<BlobListResult>;
}

/** Background task scheduler port for platform-specific lifetime management. */
export interface BackgroundTaskScheduler {
  /** Schedules work that may outlive the current response. */
  waitUntil(promise: Promise<void>): void;
}

/** Primitive values that may be used to scope portable data records. */
export type RuntimeDataPrimitive = string | number | boolean | null;

/** Stable key-value fields used to partition data records. */
export type RuntimeDataScope = Record<string, RuntimeDataPrimitive>;

/** Portable key for values stored through the functional data-store API. */
export interface RuntimeDataKey {
  /** Top-level product/runtime namespace, such as `nulledit` or `drops`. */
  namespace: string;
  /** Optional logical collection within the namespace. */
  collection?: string;
  /** Optional deterministic scope fields, such as root, branch, and snapshot ids. */
  scope?: RuntimeDataScope;
  /** Record id within the namespace, collection, and scope. */
  id: string;
}

/** Values accepted by portable secondary indexes. */
export type RuntimeDataIndexValue =
  RuntimeDataPrimitive | RuntimeDataPrimitive[];

/** Index entry emitted by callers when writing a data record. */
export interface RuntimeDataIndexEntry {
  /** Logical index name, such as `kind`, `importance`, or `text`. */
  name: string;
  /** Indexed value for exact, range, or full-text lookup. */
  value: RuntimeDataIndexValue;
  /** Optional adapter hint for how the index should be queried. */
  mode?: "exact" | "range" | "fulltext";
}

/** Cache policy hint for adapters that can cache portable data records. */
export interface RuntimeDataCachePolicy {
  /** Optional time-to-live in milliseconds. */
  ttlMs?: number;
  /** Optional invalidation tags associated with the record. */
  tags?: string[];
}

/** Options used when storing a value through `RuntimeDataStore.put`. */
export interface RuntimeDataPutOptions {
  /** Content type hint used by object-store based adapters. */
  contentType?: string;
  /** Secondary index entries the adapter may materialize for query. */
  indexes?: RuntimeDataIndexEntry[];
  /** Cache policy hint, or false to bypass adapter caching for this write. */
  cache?: RuntimeDataCachePolicy | false;
  /** Fails the write when the target record already exists. */
  ifAbsent?: boolean;
}

/** One record accepted by batched portable data-store writes. */
export interface RuntimeDataPutRecord<T = unknown> {
  /** Portable key for the value being stored. */
  key: RuntimeDataKey;
  /** Value to store for the key. */
  value: T;
  /** Optional index, cache, and write-condition hints for this record. */
  options?: RuntimeDataPutOptions;
}

/** Record returned by portable list operations. */
export interface RuntimeDataListItem<T = unknown> {
  /** Portable key for the returned value. */
  key: RuntimeDataKey;
  /** Stored record value. */
  value: T;
  /** Index entries stored with the record, when available. */
  indexes?: RuntimeDataIndexEntry[];
  /** Last write timestamp recorded by the adapter, when available. */
  updatedAt?: number;
}

/** Query options for prefix-style data listing. */
export interface RuntimeDataListQuery {
  /** Top-level namespace to list. */
  namespace: string;
  /** Optional collection filter. */
  collection?: string;
  /** Optional scope prefix filter. */
  scope?: RuntimeDataScope;
  /** Optional record id prefix filter. */
  idPrefix?: string;
  /** Adapter-specific cursor returned from a previous page. */
  cursor?: string;
  /** Maximum number of records to return. */
  limit?: number;
}

/** Paged result returned by portable list operations. */
export interface RuntimeDataListResult<T = unknown> {
  /** Records returned for the requested page. */
  items: RuntimeDataListItem<T>[];
  /** Cursor for the next page, or null when there are no more records. */
  cursor: string | null;
  /** Whether more records are available after this page. */
  truncated: boolean;
}

/** Secondary-index filter accepted by portable query operations. */
export interface RuntimeDataIndexFilter {
  /** Logical index name to filter. */
  name: string;
  /** Single value to match. */
  value?: RuntimeDataIndexValue;
  /** Multiple accepted values for exact matches. */
  values?: RuntimeDataIndexValue[];
  /** Optional adapter hint for the lookup mode. */
  mode?: "exact" | "range" | "fulltext";
}

/** Query shape used by snapshotters and provider services. */
export interface RuntimeDataQuery extends RuntimeDataListQuery {
  /** Optional secondary-index filters. */
  indexes?: RuntimeDataIndexFilter[];
  /** Optional text query for adapters with full-text search support. */
  text?: string;
}

/** Functional persistence, indexing, caching, and locking boundary for Nulldown runtimes. */
export interface RuntimeDataStore {
  /** Reads a value by portable key, returning null when absent. */
  get<T = unknown>(key: RuntimeDataKey): Promise<T | null>;
  /** Writes a value by portable key with optional index and cache hints. */
  put<T = unknown>(
    key: RuntimeDataKey,
    value: T,
    options?: RuntimeDataPutOptions,
  ): Promise<void>;
  /** Writes multiple values, allowing adapters to batch secondary indexes and projections. */
  putMany(records: RuntimeDataPutRecord[]): Promise<void>;
  /** Deletes a value by portable key. */
  delete(key: RuntimeDataKey): Promise<void>;
  /** Lists records by namespace, collection, scope, or id prefix. */
  list<T = unknown>(
    query: RuntimeDataListQuery,
  ): Promise<RuntimeDataListResult<T>>;
  /** Queries records by list filters plus optional indexes or text. */
  query<T = unknown>(query: RuntimeDataQuery): Promise<T[]>;
  /** Runs work inside the adapter's transaction boundary when supported. */
  tx<T>(work: (data: RuntimeDataStore) => Promise<T>): Promise<T>;
  /** Runs work under an adapter-provided lock for the given portable key. */
  lock<T>(
    key: RuntimeDataKey,
    work: (data: RuntimeDataStore) => Promise<T>,
  ): Promise<T>;
}

/** Bindable scalar values accepted by the portable SQL metadata port. */
export type VoidSqlBindableValue =
  | string
  | number
  | boolean
  | null
  | ArrayBuffer
  | Uint8Array;

/** Result shape returned by SQL `all` queries. */
export interface VoidSqlRows<T = Record<string, unknown>> {
  results?: T[];
}

/** Prepared-statement port shared by D1, SQLite, and test metadata stores. */
export interface VoidSqlStatement {
  /** Binds positional values and returns the statement for execution. */
  bind(...values: VoidSqlBindableValue[]): VoidSqlStatement;
  /** Executes a statement that does not need row data. */
  run(): Promise<unknown>;
  /** Reads the first row from a query, or null when no row matches. */
  first<T = Record<string, unknown>>(): Promise<T | null>;
  /** Reads all rows returned by a query. */
  all<T = Record<string, unknown>>(): Promise<VoidSqlRows<T>>;
}

/** SQL metadata store port used by the platform-neutral backend services. */
export interface VoidSqlStore {
  /** Creates a prepared statement for a SQL query. */
  prepare(sql: string): VoidSqlStatement;
  /** Executes a batch of prepared statements when the adapter supports it. */
  batch?(statements: VoidSqlStatement[]): Promise<unknown[]>;
}

/** Opaque object body accepted by the portable blob store. */
export type VoidBlobBody =
  | string
  | ArrayBuffer
  | ArrayBufferView
  | Blob
  | ReadableStream
  | null;

/** Conditional write options shared by R2 and local blob-store adapters. */
export interface VoidBlobWriteCondition {
  etagDoesNotMatch?: string;
  etagMatches?: string;
}

/** Write options for opaque blob objects. */
export interface VoidBlobPutOptions {
  httpMetadata?: { contentType?: string };
  onlyIf?: VoidBlobWriteCondition;
}

/** Object metadata returned by blob write, head, and list operations. */
export interface VoidBlobObjectMetadata {
  key: string;
  etag?: string;
  httpEtag?: string;
  uploaded?: Date;
  size?: number;
  httpMetadata?: { contentType?: string };
}

/** Full blob object returned by reads from the portable blob store. */
export interface VoidBlobObject extends VoidBlobObjectMetadata {
  body?: ReadableStream | null;
  /** Reads the object body as UTF-8 text. */
  text(): Promise<string>;
  /** Parses the object body as JSON. */
  json<T = unknown>(): Promise<T>;
}

/** Paged list result returned by blob store adapters. */
export interface VoidBlobListResult {
  objects: VoidBlobObjectMetadata[];
  truncated: boolean;
  cursor?: string;
}

/** List options for object stores that support prefix scans. */
export interface VoidBlobListOptions {
  prefix?: string;
  cursor?: string;
  startAfter?: string;
  limit?: number;
}

/** Opaque blob/object storage port used by backend services. */
export interface VoidBlobStore {
  /** Reads a blob object by key. */
  get(key: string): Promise<VoidBlobObject | null>;
  /** Reads object metadata by key without loading the body. */
  head(key: string): Promise<VoidBlobObjectMetadata | null>;
  /** Writes a blob object, optionally using conditional semantics. */
  put(
    key: string,
    value: VoidBlobBody,
    options?: VoidBlobPutOptions,
  ): Promise<VoidBlobObjectMetadata | null>;
  /** Deletes one or more blob object keys. */
  delete(keys: string | string[]): Promise<void>;
  /** Lists blob object metadata with optional prefix pagination. */
  list(options?: VoidBlobListOptions): Promise<VoidBlobListResult>;
}

/** Background task scheduler port for platform-specific lifetime management. */
export interface VoidBackgroundTasks {
  /** Schedules work that may outlive the current response. */
  waitUntil(promise: Promise<void>): void;
}

/** Primitive values that may be used to scope portable data records. */
export type VoidDataPrimitive = string | number | boolean | null;

/** Stable key-value fields used to partition data records. */
export type VoidDataScope = Record<string, VoidDataPrimitive>;

/** Portable key for values stored through the functional data-store API. */
export interface VoidDataKey {
  /** Top-level product/runtime namespace, such as `nulledit` or `drops`. */
  namespace: string;
  /** Optional logical collection within the namespace. */
  collection?: string;
  /** Optional deterministic scope fields, such as root, branch, and snapshot ids. */
  scope?: VoidDataScope;
  /** Record id within the namespace, collection, and scope. */
  id: string;
}

/** Values accepted by portable secondary indexes. */
export type VoidDataIndexValue = VoidDataPrimitive | VoidDataPrimitive[];

/** Index entry emitted by callers when writing a data record. */
export interface VoidDataIndexEntry {
  /** Logical index name, such as `kind`, `importance`, or `text`. */
  name: string;
  /** Indexed value for exact, range, or full-text lookup. */
  value: VoidDataIndexValue;
  /** Optional adapter hint for how the index should be queried. */
  mode?: "exact" | "range" | "fulltext";
}

/** Cache policy hint for adapters that can cache portable data records. */
export interface VoidDataCachePolicy {
  /** Optional time-to-live in milliseconds. */
  ttlMs?: number;
  /** Optional invalidation tags associated with the record. */
  tags?: string[];
}

/** Options used when storing a value through `VoidDataStore.put`. */
export interface VoidDataPutOptions {
  /** Content type hint used by object-store based adapters. */
  contentType?: string;
  /** Secondary index entries the adapter may materialize for query. */
  indexes?: VoidDataIndexEntry[];
  /** Cache policy hint, or false to bypass adapter caching for this write. */
  cache?: VoidDataCachePolicy | false;
  /** Fails the write when the target record already exists. */
  ifAbsent?: boolean;
}

/** Record returned by portable list operations. */
export interface VoidDataListItem<T = unknown> {
  /** Portable key for the returned value. */
  key: VoidDataKey;
  /** Stored record value. */
  value: T;
  /** Index entries stored with the record, when available. */
  indexes?: VoidDataIndexEntry[];
  /** Last write timestamp recorded by the adapter, when available. */
  updatedAt?: number;
}

/** Query options for prefix-style data listing. */
export interface VoidDataListQuery {
  /** Top-level namespace to list. */
  namespace: string;
  /** Optional collection filter. */
  collection?: string;
  /** Optional scope prefix filter. */
  scope?: VoidDataScope;
  /** Optional record id prefix filter. */
  idPrefix?: string;
  /** Adapter-specific cursor returned from a previous page. */
  cursor?: string;
  /** Maximum number of records to return. */
  limit?: number;
}

/** Paged result returned by portable list operations. */
export interface VoidDataListResult<T = unknown> {
  /** Records returned for the requested page. */
  items: VoidDataListItem<T>[];
  /** Cursor for the next page, or null when there are no more records. */
  cursor: string | null;
  /** Whether more records are available after this page. */
  truncated: boolean;
}

/** Secondary-index filter accepted by portable query operations. */
export interface VoidDataIndexFilter {
  /** Logical index name to filter. */
  name: string;
  /** Single value to match. */
  value?: VoidDataIndexValue;
  /** Multiple accepted values for exact matches. */
  values?: VoidDataIndexValue[];
  /** Optional adapter hint for the lookup mode. */
  mode?: "exact" | "range" | "fulltext";
}

/** Query shape used by snapshotters and provider services. */
export interface VoidDataQuery extends VoidDataListQuery {
  /** Optional secondary-index filters. */
  indexes?: VoidDataIndexFilter[];
  /** Optional text query for adapters with full-text search support. */
  text?: string;
}

/** Functional persistence, indexing, caching, and locking boundary for Nulldown runtimes. */
export interface VoidDataStore {
  /** Reads a value by portable key, returning null when absent. */
  get<T = unknown>(key: VoidDataKey): Promise<T | null>;
  /** Writes a value by portable key with optional index and cache hints. */
  put<T = unknown>(
    key: VoidDataKey,
    value: T,
    options?: VoidDataPutOptions,
  ): Promise<void>;
  /** Deletes a value by portable key. */
  delete(key: VoidDataKey): Promise<void>;
  /** Lists records by namespace, collection, scope, or id prefix. */
  list<T = unknown>(query: VoidDataListQuery): Promise<VoidDataListResult<T>>;
  /** Queries records by list filters plus optional indexes or text. */
  query<T = unknown>(query: VoidDataQuery): Promise<T[]>;
  /** Runs work inside the adapter's transaction boundary when supported. */
  tx<T>(work: (data: VoidDataStore) => Promise<T>): Promise<T>;
  /** Runs work under an adapter-provided lock for the given portable key. */
  lock<T>(key: VoidDataKey, work: (data: VoidDataStore) => Promise<T>): Promise<T>;
}

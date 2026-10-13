/** Query capability with query and stored value types fixed for its adapter lifetime. */
export interface QueryStore<Query, Value> {
  /** Reads matching values using the adapter's ordering and limit semantics. */
  query(query: Query): Promise<Value[]>;
}

/** Write capability with the stored value type fixed for its adapter lifetime. */
export interface WriteStore<Value> {
  /** Inserts or replaces a value using its domain identity. */
  put(value: Value): Promise<void>;
}

/** Delete capability with the domain key type fixed for its adapter lifetime. */
export interface DeleteStore<Key> {
  /** Deletes values matching the domain key. */
  delete(key: Key): Promise<void>;
}

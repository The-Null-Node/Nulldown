import { expect } from "@jest/globals";
import { createResolvedHeapProjectionRepository } from "../projection-repository";
import { createResolvedHeapDeltaRecord } from "../../../../../../shared/drop/resolved/nodeRefs";
import type {
  ResolvedHeapDeltaRecord,
  ResolvedNulldownState,
} from "../../../../../../shared/drop/resolved/types";
import type {
  BlobObjectStore,
  SqlBindableValue,
  SqlMetadataStore,
} from "../../../../../../src/server/ports";

export const source = {
  rootDropId: "projection-root",
  branchId: "owner",
  snapshotId: 0,
  content: "# Projection\n\nCurrent content.",
};

// A read-only SQL fixture deliberately returns payload rows in reverse order.
export const projectionFixture = async (state: ResolvedNulldownState) => {
  const delta = (await createResolvedHeapDeltaRecord({
    state,
    checkpointed: true,
  }))!;
  const nodes = [...(state.documentNodes ?? []), ...(state.runtimeNodes ?? [])];
  const payloads = new Map(
    delta.nodeRefs!.map((ref, index) => [
      ref.nodeHash,
      JSON.stringify(nodes[index]),
    ]),
  );
  const legacyNodes = new Map<string, string>();
  const queries: Array<{ sql: string; values: SqlBindableValue[] }> = [];
  const fixture = {
    delta: delta as ResolvedHeapDeltaRecord | null,
    legacyState: null as ResolvedNulldownState | null,
  };
  const db: SqlMetadataStore = {
    prepare(sql) {
      let values: SqlBindableValue[] = [];
      const matchesTarget = () =>
        JSON.stringify(values) ===
        JSON.stringify([
          state.rootDropId,
          state.branchId,
          state.snapshotId,
          state.resolverId,
        ]);
      return {
        bind(...bindings) {
          values = bindings;
          return this;
        },
        async run() {
          throw new Error(`Unexpected write: ${sql}`);
        },
        async first<T>() {
          queries.push({ sql, values });
          if (sql.includes("FROM resolved_heap_deltas")) {
            return (
              matchesTarget() && fixture.delta
                ? { heap_delta_json: JSON.stringify(fixture.delta) }
                : null
            ) as T | null;
          }
          if (sql.includes("FROM resolved_heaps")) {
            return (
              matchesTarget() && fixture.legacyState
                ? { state_json: JSON.stringify(fixture.legacyState) }
                : null
            ) as T | null;
          }
          throw new Error(`Unexpected first: ${sql}`);
        },
        async all<T>() {
          queries.push({ sql, values });
          if (sql.includes("FROM resolved_node_payloads")) {
            expect(sql).toContain("node_hash IN (");
            expect(sql.match(/\?/g)).toHaveLength(values.length);
            expect(values.length).toBeLessThanOrEqual(100);
            return {
              results: [...payloads]
                .reverse()
                .filter(([hash]) => values.includes(hash))
                .map(([node_hash, node_json]) => ({
                  node_hash,
                  node_json,
                })) as T[],
            };
          }
          if (sql.includes("FROM resolved_nodes")) {
            return {
              results: (matchesTarget()
                ? [...legacyNodes]
                    .reverse()
                    .map(([node_id, node_json]) => ({ node_id, node_json }))
                : []) as T[],
            };
          }
          throw new Error(`Unexpected all: ${sql}`);
        },
      };
    },
  };
  const read = () =>
    createResolvedHeapProjectionRepository({ sql: db }).readState(
      state.rootDropId,
      state.branchId!,
      state.resolverId,
      state.snapshotId!,
    );
  return { db, read, fixture, delta, payloads, legacyNodes, queries };
};

export const memoryBlobs = (): BlobObjectStore => {
  const values = new Map<string, string>();
  const etags = new Map<string, string>();
  let revision = 0;
  return {
    async get(key) {
      const value = values.get(key);
      return value === undefined
        ? null
        : {
            key,
            etag: etags.get(key),
            text: async () => value,
            json: async <T>() => JSON.parse(value) as T,
          };
    },
    async put(key, value, options) {
      if (typeof value !== "string") throw new Error("Expected string blob");
      if (options?.onlyIf?.etagDoesNotMatch === "*" && values.has(key))
        return null;
      if (
        options?.onlyIf?.etagMatches &&
        options.onlyIf.etagMatches !== etags.get(key)
      )
        return null;
      values.set(key, value);
      etags.set(key, String(++revision));
      return { key, etag: etags.get(key) };
    },
    async head(key) {
      return values.has(key) ? { key, etag: etags.get(key) } : null;
    },
    async delete(keys) {
      for (const key of [keys].flat()) values.delete(key);
    },
    async list(options) {
      const keys = [...values.keys()]
        .sort()
        .filter((key) => key.startsWith(options?.prefix ?? ""));
      const offset = Number(options?.cursor ?? 0);
      const page = keys.slice(offset, offset + (options?.limit ?? 1000));
      const truncated = offset + page.length < keys.length;
      return {
        objects: page.map((key) => ({ key })),
        truncated,
        cursor: truncated ? String(offset + page.length) : undefined,
      };
    },
  };
};

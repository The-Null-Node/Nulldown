import { describe, expect, it } from "@jest/globals";
import { createDropIdentityRepository, createRemoteAliasKey } from "./id";
import type {
  BlobObjectStore,
  SqlBindableValue,
  SqlStatement,
  SqlMetadataStore,
} from "../../../../../src/server/ports";

class AliasBlobStore implements BlobObjectStore {
  readonly values = new Map<string, string>();
  gets = 0;
  puts = 0;
  deletes = 0;

  async get(key: string) {
    this.gets += 1;
    const value = this.values.get(key);
    return value === undefined
      ? null
      : {
          key,
          text: async () => value,
          json: async <T>() => JSON.parse(value) as T,
        };
  }

  async head() {
    return null;
  }

  async put(
    key: string,
    value:
      string | ArrayBuffer | ArrayBufferView | Blob | ReadableStream | null,
  ) {
    this.puts += 1;
    this.values.set(key, await new Response(value as BodyInit | null).text());
    return { key };
  }

  async delete(): Promise<void> {
    this.deletes += 1;
  }

  async list() {
    return { objects: [], truncated: false };
  }
}

class AliasDatabase implements SqlMetadataStore {
  readonly aliases = new Map<string, string>();
  reads = 0;
  runs = 0;

  prepare(sql: string): SqlStatement {
    let values: SqlBindableValue[] = [];
    const statement: SqlStatement = {
      bind: (...bound) => {
        values = bound;
        return statement;
      },
      first: async <T>() => {
        this.reads += 1;
        const fullId = this.aliases.get(String(values[0]));
        return (fullId ? { full_id: fullId } : null) as T | null;
      },
      run: async () => {
        this.runs += 1;
        if (sql.includes("INSERT INTO drop_aliases")) {
          this.aliases.set(String(values[0]), String(values[1]));
        }
        return { success: true };
      },
      all: async <T>() => ({ results: [] as T[] }),
    };
    return statement;
  }
}

describe("drop identity read-request resolution", () => {
  it("returns full ids canonically without blob or SQL I/O", async () => {
    const blobs = new AliasBlobStore();
    const sql = new AliasDatabase();
    const repository = createDropIdentityRepository({ blobs, sql });

    await expect(
      repository.resolveRemoteDropIdForReadRequest("IdentityFull01"),
    ).resolves.toBe("IdentityFull01");
    expect({
      blobGets: blobs.gets,
      sqlReads: sql.reads,
      sqlRuns: sql.runs,
    }).toEqual({
      blobGets: 0,
      sqlReads: 0,
      sqlRuns: 0,
    });
  });

  it("resolves an R2-only short alias and caches it without persistent writes", async () => {
    const blobs = new AliasBlobStore();
    const sql = new AliasDatabase();
    const repository = createDropIdentityRepository({ blobs, sql });
    blobs.values.set(createRemoteAliasKey("Read01"), "IdentityAliasRead01");

    await expect(
      repository.resolveRemoteDropIdForReadRequest("Read01"),
    ).resolves.toBe("IdentityAliasRead01");
    await expect(
      repository.resolveRemoteDropIdForReadRequest("Read01"),
    ).resolves.toBe("IdentityAliasRead01");
    expect(sql.runs).toBe(0);
    expect(blobs.gets).toBe(1);
    expect(blobs.puts).toBe(0);
    expect(blobs.deletes).toBe(0);

    await expect(repository.resolveRemoteDropId("Read01")).resolves.toBe(
      "IdentityAliasRead01",
    );
    expect(sql.runs).toBe(1);
  });

  it("preserves missing short-alias compatibility", async () => {
    const repository = createDropIdentityRepository({
      blobs: new AliasBlobStore(),
      sql: new AliasDatabase(),
    });
    await expect(
      repository.resolveRemoteDropIdForReadRequest("Miss01"),
    ).resolves.toBe("Miss01");
  });

  it("keeps general resolution backfilling an R2-only alias into SQL", async () => {
    const blobs = new AliasBlobStore();
    const sql = new AliasDatabase();
    const repository = createDropIdentityRepository({ blobs, sql });
    blobs.values.set(createRemoteAliasKey("Writ01"), "IdentityAliasWrite01");

    await expect(repository.resolveRemoteDropId("Writ01")).resolves.toBe(
      "IdentityAliasWrite01",
    );
    expect(sql.runs).toBe(1);
    expect(sql.aliases.get("Writ01")).toBe("IdentityAliasWrite01");
  });
});

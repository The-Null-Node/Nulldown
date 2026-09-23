import { jest } from "@jest/globals";
import type { R2Bucket } from "@cloudflare/workers-types";
import { onRequestGet } from "../get/[id]";
import {
  createDeleteRequest,
  createStoreDatabase,
  MemoryR2Bucket,
} from "../_lib/drops/testing/storage-fixture";
import { onRequestDelete } from "./[id]";

describe("drop deletion contracts", () => {
  let infoSpy: jest.SpiedFunction<typeof console.info>;
  let warnSpy: jest.SpiedFunction<typeof console.warn>;
  let errorSpy: jest.SpiedFunction<typeof console.error>;
  let debugSpy: jest.SpiedFunction<typeof console.debug>;

  beforeEach(() => {
    infoSpy = jest.spyOn(console, "info").mockImplementation(() => {});
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    debugSpy = jest.spyOn(console, "debug").mockImplementation(() => {});
  });

  afterEach(() => {
    infoSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    debugSpy.mockRestore();
  });

  it("returns 412 revision_precondition_failed from /api/delete/:id as structured JSON", async () => {
    const bucket = new MemoryR2Bucket();
    const id = "ZxCvBn123456";
    bucket.seed(id, "drop body", "text/plain");
    const db = createStoreDatabase({
      entry: {
        entry_seq: 1,
        drop_id: id,
        account_id: "account-owner",
        visibility: "unlisted",
        created_at: 1,
        updated_at: 1,
        deleted_at: null,
      },
    });

    const response = await onRequestDelete({
      request: createDeleteRequest(id, "wrong-revision", "account-owner"),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        DB: db as never,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
      },
      params: {
        id,
      },
    } as unknown as Parameters<typeof onRequestDelete>[0]);

    const body = (await response.json()) as {
      error: string;
      code: string;
      details?: Record<string, unknown>;
    };

    expect(response.status).toBe(412);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(body.code).toBe("revision_precondition_failed");
    expect(body.error).toContain("Refresh and try again");
    expect(await bucket.get(id)).not.toBeNull();
  });

  it("requires an authenticated owner and revision before deleting a projected root", async () => {
    const bucket = new MemoryR2Bucket();
    const id = "DeleteGuard001";
    const etag = bucket.seed(id, "drop body", "text/plain");
    const db = createStoreDatabase({
      entry: {
        entry_seq: 1,
        drop_id: id,
        account_id: "account-owner",
        visibility: "unlisted",
        created_at: 1,
        updated_at: 1,
        deleted_at: null,
      },
    });
    const env = {
      R2_BUCKET: bucket as unknown as R2Bucket,
      DB: db as never,
      ALLOW_INSECURE_ACCOUNT_HEADER: "1",
    };

    const anonymous = await onRequestDelete({
      request: createDeleteRequest(id, etag),
      env,
      params: { id },
    } as unknown as Parameters<typeof onRequestDelete>[0]);
    const foreign = await onRequestDelete({
      request: createDeleteRequest(id, etag, "account-foreign"),
      env,
      params: { id },
    } as unknown as Parameters<typeof onRequestDelete>[0]);
    const missingRevision = await onRequestDelete({
      request: createDeleteRequest(id, undefined, "account-owner"),
      env,
      params: { id },
    } as unknown as Parameters<typeof onRequestDelete>[0]);

    expect(anonymous.status).toBe(401);
    expect(foreign.status).toBe(404);
    expect(missingRevision.status).toBe(428);
    await expect(bucket.get(id)).resolves.not.toBeNull();
  });

  it("deletes only an active projected root owned at the supplied revision", async () => {
    const bucket = new MemoryR2Bucket();
    const id = "DeleteOwner002";
    const etag = bucket.seed(id, "drop body", "text/plain");
    const db = createStoreDatabase({
      entry: {
        entry_seq: 1,
        drop_id: id,
        account_id: "account-owner",
        visibility: "unlisted",
        created_at: 1,
        updated_at: 1,
        deleted_at: null,
      },
    });

    const response = await onRequestDelete({
      request: createDeleteRequest(id, `"${etag}"`, "account-owner"),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        DB: db as never,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
      },
      params: { id },
    } as unknown as Parameters<typeof onRequestDelete>[0]);

    expect(response.status).toBe(204);
    await expect(bucket.get(id)).resolves.toBeNull();
  });

  it("fails closed when account-library storage is unavailable for deletion", async () => {
    const bucket = new MemoryR2Bucket();
    const id = "DeleteNoDb0003";
    const etag = bucket.seed(id, "drop body", "text/plain");

    const response = await onRequestDelete({
      request: createDeleteRequest(id, etag, "account-owner"),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
      },
      params: { id },
    } as unknown as Parameters<typeof onRequestDelete>[0]);

    expect(response.status).toBe(503);
    await expect(bucket.get(id)).resolves.not.toBeNull();
  });

  it("tombstones a root before a failed metadata cleanup can leave it readable", async () => {
    const bucket = new MemoryR2Bucket();
    const id = "DeleteTomb005";
    const etag = bucket.seed(id, "drop body", "text/plain");
    const entry = {
      entry_seq: 1,
      drop_id: id,
      account_id: "account-owner",
      visibility: "unlisted" as const,
      created_at: 1,
      updated_at: 1,
      deleted_at: null as number | null,
    };
    const db = {
      prepare(sql: string) {
        const statement = {
          bind: () => statement,
          first: async () =>
            sql.includes("FROM account_library_entries") ? entry : null,
          all: async () => ({ results: [] }),
          run: async () => {
            if (sql.includes("UPDATE account_library_entries")) {
              entry.deleted_at = Date.now();
              return { success: true };
            }
            if (sql.includes("DELETE FROM drops")) {
              throw new Error("metadata cleanup failed");
            }
            return { success: true };
          },
        };
        return statement;
      },
    };
    const env = {
      R2_BUCKET: bucket as unknown as R2Bucket,
      DB: db as never,
      ALLOW_INSECURE_ACCOUNT_HEADER: "1",
    };

    const response = await onRequestDelete({
      request: createDeleteRequest(id, etag, "account-owner"),
      env,
      params: { id },
    } as unknown as Parameters<typeof onRequestDelete>[0]);
    const read = await onRequestGet({
      request: new Request(`https://nulldown.test/api/get/${id}`),
      env,
      params: { id },
    } as unknown as Parameters<typeof onRequestGet>[0]);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ error: "Failed to delete drop." }),
    );
    expect(entry.deleted_at).not.toBeNull();
    await expect(bucket.get(id)).resolves.not.toBeNull();
    expect(read.status).toBe(404);
  });
});

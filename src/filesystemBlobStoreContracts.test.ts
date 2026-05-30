import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFilesystemBlobStore } from "./server/filesystemBlobStore";

describe("createFilesystemBlobStore", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "nulldown-blob-"));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("stores, reads, heads, lists, and deletes blob objects", async () => {
    const store = createFilesystemBlobStore({ rootDir });

    const written = await store.put("drops/root.json", JSON.stringify({ ok: true }), {
      httpMetadata: { contentType: "application/json" },
    });

    expect(written?.key).toBe("drops/root.json");
    expect(written?.httpMetadata?.contentType).toBe("application/json");

    await expect(store.get("drops/root.json").then((object) => object?.json()))
      .resolves.toEqual({ ok: true });
    expect((await store.head("drops/root.json"))?.etag).toBe(written?.etag);
    expect((await store.list({ prefix: "drops/" })).objects.map((object) => object.key))
      .toEqual(["drops/root.json"]);

    await store.delete("drops/root.json");

    await expect(store.get("drops/root.json")).resolves.toBeNull();
  });

  it("honors absent-only conditional writes", async () => {
    const store = createFilesystemBlobStore({ rootDir });

    await expect(
      store.put("locks/root", "first", { onlyIf: { etagDoesNotMatch: "*" } }),
    ).resolves.toEqual(expect.objectContaining({ key: "locks/root" }));
    await expect(
      store.put("locks/root", "second", { onlyIf: { etagDoesNotMatch: "*" } }),
    ).resolves.toBeNull();
    await expect(store.get("locks/root").then((object) => object?.text()))
      .resolves.toBe("first");
  });

  it("rejects traversal-style keys", async () => {
    const store = createFilesystemBlobStore({ rootDir });

    await expect(store.put("../bad", "nope")).rejects.toThrow("void_blob_invalid_key");
  });
});

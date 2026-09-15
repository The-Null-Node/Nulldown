import { describe, expect, test } from "bun:test";
import { encryptionKeys, signingKeys } from "@openauthjs/openauth/keys";
import { CloudflareStorage } from "@openauthjs/openauth/storage/cloudflare";
import type { StorageAdapter } from "@openauthjs/openauth/storage/storage";

describe("OpenAuth key storage patch", () => {
  test.each([
    ["signing", signingKeys, "ES256", "sig"],
    ["encryption", encryptionKeys, "RSA-OAEP-512", undefined],
  ] as const)(
    "returns a newly persisted %s key when the following scan remains stale",
    async (family, loadKeys, algorithm, use) => {
      const writes: Array<{ key: string[]; value: Record<string, unknown> }> = [];
      let exposeExpiredKey = false;
      const storage: StorageAdapter = {
        async get() {
          return undefined;
        },
        async remove() {},
        async set(key, value) {
          writes.push({ key, value: value as Record<string, unknown> });
        },
        async *scan(prefix) {
          const write = writes[0];
          if (!exposeExpiredKey || !write) return;
          yield [
            [...prefix, String(write.value.id)],
            { ...write.value, expired: Date.now() },
          ];
        },
      };

      const keys = await loadKeys(storage);

      expect(writes).toHaveLength(1);
      expect(writes[0]?.key).toEqual([`${family}:key`, keys[0]?.id]);
      expect(writes[0]?.value.id).toBe(keys[0]?.id);
      expect(keys).toHaveLength(1);
      expect(keys[0]?.alg).toBe(algorithm);
      expect(keys[0]?.jwk.kid).toBe(keys[0]?.id);
      expect(keys[0]?.jwk.use).toBe(use);
      expect(keys[0]?.private.extractable).toBe(false);
      expect(Object.hasOwn(keys[0] ?? {}, "expired")).toBe(true);
      expect(keys[0]?.expired).toBeUndefined();

      exposeExpiredKey = true;
      const rotatedKeys = await loadKeys(storage);

      expect(writes).toHaveLength(2);
      expect(rotatedKeys).toHaveLength(2);
      expect(rotatedKeys[0]?.id).toBe(writes[1]?.value.id);
      expect(rotatedKeys[1]?.id).toBe(keys[0]?.id);
      expect(rotatedKeys[1]?.expired).toBeInstanceOf(Date);
    },
    10_000,
  );

  test("reads listed Cloudflare KV values in exact 100-name batches and list order", async () => {
    const separator = String.fromCharCode(31);
    const prefix = `signing:key${separator}`;
    const firstPage = Array.from({ length: 121 }, (_, index) => `${prefix}${index}`);
    const finalName = `${prefix}final`;
    const missingName = firstPage[37];
    const bulkReads: string[][] = [];
    const listCalls: Array<{ prefix?: string; cursor?: string }> = [];
    const pages = [
      {
        keys: firstPage.map((name) => ({ name })),
        list_complete: false,
        cursor: "next-1",
      },
      { keys: [], list_complete: false, cursor: "next-2" },
      { keys: [{ name: finalName }], list_complete: true },
    ];

    const namespace = {
      async get(names: string[], type: "json") {
        expect(type).toBe("json");
        bulkReads.push([...names]);
        return new Map(
          [...names]
            .reverse()
            .map((name) => [name, name === missingName ? null : { name }] as const),
        );
      },
      async list(options: { prefix?: string; cursor?: string }) {
        listCalls.push(options);
        return pages[listCalls.length - 1];
      },
    };
    const storage = CloudflareStorage({ namespace: namespace as unknown as KVNamespace });
    const names: string[] = [];

    for await (const [, value] of storage.scan(["signing:key"])) {
      names.push((value as { name: string }).name);
    }

    expect(bulkReads.map((batch) => batch.length)).toEqual([100, 21, 1]);
    expect(bulkReads.flat()).toEqual([...firstPage, finalName]);
    expect(names).toEqual([...firstPage.filter((name) => name !== missingName), finalName]);
    expect(listCalls).toEqual([
      { prefix, cursor: undefined },
      { prefix, cursor: "next-1" },
      { prefix, cursor: "next-2" },
    ]);
  });
});

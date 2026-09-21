import { jest } from "@jest/globals";
import type { R2Bucket } from "@cloudflare/workers-types";
import { onRequestGet } from "../../../get/[id]";
import { MemoryR2Bucket } from "../testing/storage-fixture";

describe("root drop read contracts", () => {
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

  it("keeps projected public and unlisted links readable while private links remain account-gated", async () => {
    const bucket = new MemoryR2Bucket();
    bucket.seed("PublicLink123", "public body", "text/plain");

    const read = async (visibility: "private" | "unlisted" | "public") => {
      const db = {
        prepare: jest.fn(() => ({
          bind: jest.fn().mockReturnThis(),
          first: jest.fn().mockResolvedValue({
            entry_seq: 1,
            drop_id: "PublicLink123",
            account_id: "account-1",
            visibility,
            created_at: 1,
            updated_at: 1,
            deleted_at: null,
          }),
        })),
      };
      return onRequestGet({
        request: new Request("https://nulldown.test/api/get/PublicLink123"),
        env: { R2_BUCKET: bucket as unknown as R2Bucket, DB: db },
        params: { id: "PublicLink123" },
      } as unknown as Parameters<typeof onRequestGet>[0]);
    };

    await expect(read("public")).resolves.toHaveProperty("status", 200);
    await expect(read("unlisted")).resolves.toHaveProperty("status", 200);
    await expect(read("private")).resolves.toHaveProperty("status", 404);
  });
});

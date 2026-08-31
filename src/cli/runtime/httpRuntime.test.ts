import type { DropEnvelopeV1 } from "../../../shared/drop/types";
import { createHttpNulldownRuntime } from "./httpRuntime";

describe("HTTP drop runtime", () => {
  it("posts a sealed create envelope without plaintext fields", async () => {
    const calls: Array<{ path: string; options?: RequestInit }> = [];
    const request = async <T = unknown>(path: string, options?: RequestInit) => {
      calls.push({ path, options });
      return { data: { id: "drop-1", url: "https://nulldown.test/d/drop-1" } as T };
    };
    const runtime = createHttpNulldownRuntime({ readDrop: async () => { throw new Error("unused"); }, request });
    const envelope = { schema: "nmdn.drop.v1", version: 1 } as DropEnvelopeV1;

    await runtime.drops.create({ content: "plaintext", metadata: { themeId: "system" }, envelope });

    expect(calls).toEqual([{
      path: "/api/store",
      options: expect.objectContaining({ method: "POST", body: JSON.stringify({ envelope }) }),
    }]);
  });

  it("preserves an update revision while replacing plaintext with an envelope", async () => {
    const calls: Array<{ path: string; options?: RequestInit }> = [];
    const request = async <T = unknown>(path: string, options?: RequestInit) => {
      calls.push({ path, options });
      return { data: { id: "drop-1", url: "https://nulldown.test/d/drop-1" } as T };
    };
    const runtime = createHttpNulldownRuntime({ readDrop: async () => { throw new Error("unused"); }, request });
    const envelope = { schema: "nmdn.drop.v1", version: 1 } as DropEnvelopeV1;

    await runtime.drops.update({
      id: "drop-1",
      content: "replacement",
      metadata: { themeId: "system" },
      envelope,
      expectedRevision: "revision-1",
    });

    expect(calls).toEqual([{
      path: "/api/store",
      options: expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          id: "drop-1",
          upsert: true,
          envelope,
          expectedRevision: "revision-1",
        }),
      }),
    }]);
  });
});

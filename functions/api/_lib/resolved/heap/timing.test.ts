import { jest } from "@jest/globals";
import {
  createResolvedHeapTiming,
  type ResolvedHeapTimingEvent,
} from "./timing";
import type { SqlStatement } from "../../../../../src/server/ports";

const request = () =>
  new Request("https://example.test/query?q=private-query", {
    headers: { "x-request-id": "timing-test" },
  });

const statement = (run: SqlStatement["run"]): SqlStatement => ({
  bind() {
    return this;
  },
  run,
  first: async () => null,
  all: async () => ({ results: [] }),
});

describe("resolved heap request timing", () => {
  it.each(["throw", "reject"])(
    "preserves results and exact errors when the observer %ss",
    async (failure) => {
      const timing = createResolvedHeapTiming(request(), {}, () => {
        if (failure === "throw") throw new Error("observer unavailable");
        return Promise.reject(new Error("observer unavailable"));
      });
      const result = { meta: { duration: 2 } };
      let calls = 0;
      expect(
        await timing.phase("write", (span) =>
          span.write(
            statement(async () => {
              calls += 1;
              return result;
            }),
          ),
        ),
      ).toBe(result);
      const error = new Error("database failure containing private SQL");
      await expect(
        timing.phase("write", (span) =>
          span.write(
            statement(async () => {
              calls += 1;
              throw error;
            }),
          ),
        ),
      ).rejects.toBe(error);
      expect(calls).toBe(2);
    },
  );

  it("bounds progress records and attributes partial writes to the failed phase", async () => {
    const events: ResolvedHeapTimingEvent[] = [];
    const timing = createResolvedHeapTiming(request(), {}, (event) => {
      events.push(event);
    });
    const error = new Error("private SQL and bindings");
    const value = { meta: { timings: { sql_duration_ms: 2 }, duration: 999 } };
    await expect(
      timing.phase(
        "projection.node-writes",
        async (span) => {
          for (let index = 0; index < 1205; index += 1) {
            expect(await span.write(statement(async () => value))).toBe(value);
          }
          await span.write(
            statement(async () => {
              throw error;
            }),
          );
        },
        1205,
      ),
    ).rejects.toBe(error);
    expect(events.filter((event) => event.outcome === "progress")).toHaveLength(
      10,
    );
    expect(events.at(-1)).toMatchObject({
      phase: "projection.node-writes",
      outcome: "error",
      writesAttempted: 1206,
      writesCompleted: 1205,
      sqlDurationMs: 2410,
      sqlMetadataCount: 1205,
    });
    expect(JSON.stringify(events)).not.toMatch(/private|bindings|SELECT/);
  });

  it("uses default structured logging and tolerates a throwing console", async () => {
    const info = jest.spyOn(console, "info").mockImplementation(() => {});
    const debug = jest.spyOn(console, "debug").mockImplementation(() => {});
    try {
      const timing = createResolvedHeapTiming(request(), {});
      await timing.phase("query", async () => 1);
      await timing.phase("read.sql-projection", async () => 2);
      expect(info).toHaveBeenCalledTimes(2);
      expect(debug).not.toHaveBeenCalled();
      expect(JSON.parse(info.mock.calls[1][0] as string)).toMatchObject({
        event: "resolved.heap.phase",
        route: "resolved.heap.query",
        requestId: "timing-test",
        outcome: "complete",
      });
      expect(info.mock.calls.flat().join(" ")).not.toContain("private-query");
      info.mockImplementation(() => {
        throw new Error("console unavailable");
      });
      await expect(
        timing.phase("projection.generate", async () => 42),
      ).resolves.toBe(42);
    } finally {
      info.mockRestore();
      debug.mockRestore();
    }
  });
});

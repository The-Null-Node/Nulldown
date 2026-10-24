import { decodeTelemetryEvent } from "../../../../../shared/observability/events";
import { deliverTelemetry, readTelemetryBatch } from "./transport";
import { onRequest } from "../../../_middleware";
import type { EventContext } from "@cloudflare/workers-types";
import { jest } from "@jest/globals";

const event = {
  version: 1,
  event: "http.complete",
  operationId: "637f7584-1781-411f-ab2f-051776f1aac0",
  timestamp: 1,
  outcome: "success",
  surface: "auth",
};

describe("bounded diagnostic transport", () => {
  it("bounds no-follow delivery and stalled ingestion even for noncooperative ports", async () => {
    jest.useFakeTimers();
    try {
      let sent: Request | undefined;
      const task = deliverTelemetry(
        {
          fetch: async (request) => {
            sent = request;
            return new Promise(() => {});
          },
        },
        [],
        "server",
      );
      await jest.advanceTimersByTimeAsync(501);
      await task;
      expect(sent?.redirect).toBe("manual");
      expect(sent?.signal.aborted).toBe(true);
      const read = readTelemetryBatch(
        new Request("https://test/", {
          method: "POST",
          body: new ReadableStream({ start() {} }),
          duplex: "half",
        } as RequestInit),
      );
      await jest.advanceTimersByTimeAsync(501);
      expect(await read).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
  it("closed waitUntil never overrides successful or rejected application outcomes", async () => {
    const failure = new Error("application rejection");
    for (const reject of [false, true]) {
      const ctx = {
        request: new Request("https://test/api/get/local"),
        env: {},
        next: async () => {
          if (reject) throw failure;
          return new Response("kept", { status: 201 });
        },
        waitUntil() {
          throw Error("closed context");
        },
      };
      const run = onRequest(
        ctx as unknown as EventContext<
          typeof ctx.env,
          string,
          Record<string, unknown>
        >,
      );
      if (reject) await expect(run).rejects.toBe(failure);
      else expect((await run).status).toBe(201);
    }
  });
  it("strips sensitive and unrecognized fields before forwarding", async () => {
    const request = new Request("https://test/", {
      method: "POST",
      body: JSON.stringify([
        {
          ...event,
          cookie: "private",
          reason: "secret-token",
          surface: "/api/get/private-id?token=private",
        },
      ]),
    });
    const decoded = await readTelemetryBatch(request);
    expect(decoded).toEqual([
      {
        version: 1,
        event: "http.complete",
        operationId: event.operationId,
        timestamp: 1,
        outcome: "success",
      },
    ]);
  });

  it("rejects overlarge bodies without relying on Content-Length", async () => {
    expect(
      await readTelemetryBatch(
        new Request("https://test/", {
          method: "POST",
          body: "x".repeat(16_385),
        }),
      ),
    ).toBeNull();
  });

  it("rejects oversized batches and arbitrary operation identifiers", async () => {
    expect(
      await readTelemetryBatch(
        new Request("https://test/", {
          method: "POST",
          body: JSON.stringify(Array(21).fill(event)),
        }),
      ),
    ).toBeNull();
    expect(
      decodeTelemetryEvent({ ...event, operationId: "Bearer secret" }),
    ).toBeNull();
  });

  it("does not reject application work when collection fails", async () => {
    await expect(
      deliverTelemetry(
        {
          fetch: async () => {
            throw new Error("unavailable");
          },
        },
        [],
        "server",
      ),
    ).resolves.toBeUndefined();
  });

  it("preserves response cookies and propagates request correlation", async () => {
    const captured: Request[] = [];
    const tasks: Promise<unknown>[] = [];
    const context = {
      request: new Request("https://nulldown.app/api/auth/open/principal", {
        headers: { "x-operation-id": event.operationId },
      }),
      env: {
        TELEMETRY: {
          fetch: async (request: Request) => {
            captured.push(request);
            return new Response(null, { status: 204 });
          },
        },
      },
      next: async (request: Request) => {
        expect(request.headers.get("x-operation-id")).toBe(event.operationId);
        const headers = new Headers({
          "x-diagnostic-reason": "refresh_completed",
        });
        headers.append("Set-Cookie", "access=one; HttpOnly");
        headers.append("Set-Cookie", "refresh=two; HttpOnly");
        return new Response("body", { headers });
      },
      waitUntil: (task: Promise<unknown>) => tasks.push(task),
    };
    const response = await onRequest(
      context as unknown as EventContext<
        typeof context.env,
        string,
        Record<string, unknown>
      >,
    );
    expect(await response.text()).toBe("body");
    expect(response.headers.get("Set-Cookie")).toContain("access=one");
    expect(response.headers.get("Set-Cookie")).toContain("refresh=two");
    await Promise.all(tasks);
    const records = await captured[0].json();
    expect(records).toEqual([
      expect.objectContaining({
        operationId: event.operationId,
        requestId: response.headers.get("x-request-id"),
        reason: "refresh_completed",
      }),
    ]);
  });
});

import { jest } from "@jest/globals";
import { runCli, type CliFetch, type RunCliDependencies } from "./index";

const captureOutput = (
  dependencies: RunCliDependencies = {},
): {
  stdout: string[];
  stderr: string[];
  dependencies: RunCliDependencies;
} => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    dependencies: {
      ...dependencies,
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
  };
};

describe("CLI diagnostics", () => {
  it("verbose logs correlate requests without leaking canary secrets", async () => {
    const secret = "canary-token-value";
    const fetchImpl = jest.fn<CliFetch>(async (_input, init) => {
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        `Bearer ${secret}`,
      );
      expect(new Headers(init?.headers).get("x-request-id")).toBe(
        "request-123",
      );
      return Response.json(
        { error: `denied ${secret}`, code: "auth_failed" },
        { status: 401 },
      );
    });
    const output = captureOutput({
      fetch: fetchImpl,
      createRequestId: () => "request-123",
      now: (() => {
        let current = 100;
        return () => (current += 5);
      })(),
    });

    const result = await runCli(
      ["list", "--json", "--verbose", "--token", secret],
      output.dependencies,
    );

    expect(result).toEqual({ exitCode: 1 });
    expect(output.stdout).toEqual([]);
    expect(output.stderr.join("\n")).not.toContain(secret);
    const records = output.stderr.map((line) => JSON.parse(line));
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "diagnostic",
          event: "http.start",
          requestId: "request-123",
        }),
        expect.objectContaining({
          type: "diagnostic",
          event: "http.error",
          requestId: "request-123",
          status: 401,
          code: "auth_failed",
        }),
        {
          error: "denied [redacted]",
          code: "auth_failed",
          status: 401,
        },
      ]),
    );
  });

  it("redacts environment-backed admin tokens from failures", async () => {
    const secret = "admin-canary-token";
    const previousToken = process.env.BRANCH_HEAP_BACKFILL_TOKEN;
    process.env.BRANCH_HEAP_BACKFILL_TOKEN = secret;
    const output = captureOutput({
      fetch: async () =>
        Response.json(
          { error: `denied ${secret}`, code: "auth_failed" },
          { status: 401 },
        ),
    });

    try {
      const result = await runCli(
        ["admin", "branch-backfill", "root-1", "--json"],
        output.dependencies,
      );

      expect(result).toEqual({ exitCode: 1 });
      expect(output.stderr.join("\n")).not.toContain(secret);
      expect(JSON.parse(output.stderr[0]!)).toEqual({
        error: "denied [redacted]",
        code: "auth_failed",
        status: 401,
      });
    } finally {
      if (previousToken === undefined) {
        delete process.env.BRANCH_HEAP_BACKFILL_TOKEN;
      } else {
        process.env.BRANCH_HEAP_BACKFILL_TOKEN = previousToken;
      }
    }
  });

  it("keeps human diagnostics on stderr and command data on stdout", async () => {
    const output = captureOutput({
      fetch: async () => Response.json({ items: [], cursor: null }),
      createRequestId: () => "request-human",
      now: () => 100,
    });

    const result = await runCli(["list", "--verbose"], output.dependencies);

    expect(result).toEqual({ exitCode: 0 });
    expect(output.stdout).toHaveLength(1);
    expect(output.stdout[0]).toContain('"items": []');
    expect(output.stderr.length).toBeGreaterThan(0);
    expect(output.stderr.every((line) => line.startsWith("[nd] "))).toBe(true);
  });

  it("preserves secret-like substrings in successful command data", async () => {
    const output = captureOutput({
      fetch: async () => Response.json({ items: ["cat"], cursor: null }),
    });

    const result = await runCli(
      ["list", "--json", "--token", "a"],
      output.dependencies,
    );

    expect(result).toEqual({ exitCode: 0 });
    expect(output.stderr).toEqual([]);
    expect(JSON.parse(output.stdout[0]!)).toEqual({
      items: ["cat"],
      cursor: null,
    });
  });

  it("malformed successful responses fail with a stable code", async () => {
    const output = captureOutput({
      fetch: async () =>
        new Response("{not-json", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      createRequestId: () => "request-invalid-json",
    });

    const result = await runCli(["list", "--json"], output.dependencies);

    expect(result).toEqual({ exitCode: 1 });
    expect(output.stdout).toEqual([]);
    expect(output.stderr).toHaveLength(1);
    expect(JSON.parse(output.stderr[0]!)).toEqual({
      error: "Response body was not valid JSON.",
      code: "invalid_json_response",
      status: 200,
    });
  });

  it("times out outbound requests with a stable code", async () => {
    const output = captureOutput({
      fetch: async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        }),
      requestTimeoutMs: 1,
      createRequestId: () => "request-timeout",
    });

    const result = await runCli(["list", "--json"], output.dependencies);

    expect(result).toEqual({ exitCode: 1 });
    expect(output.stdout).toEqual([]);
    expect(JSON.parse(output.stderr[0]!)).toEqual({
      error: "Request timed out.",
      code: "request_timeout",
    });
  });
});

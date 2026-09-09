import { jest } from "@jest/globals";
import { runCli } from "./index";

describe("CLI diff apply", () => {
  it("posts a complete explicit retry identity without a preliminary branch read", async () => {
    const stdout: string[] = [];
    const fetchImpl = jest.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url === "http://example.test/api/get/root-1") {
        return Response.json({ content: "root" }, {
          headers: { "X-Drop-Canonical-Id": "root-1" },
        });
      }
      expect(url).toBe("http://example.test/api/diff/root-1?branchId=branch-1");
      expect(init?.method).toBe("POST");
      const eventId = JSON.parse(String(init?.body)).events[0].eventId;
      return Response.json({
        accepted: 1,
        deduplicated: 0,
        branchId: "branch-1",
        snapshotId: 1,
        totalStored: 1,
        acknowledgements: [{ eventId, seq: 0, snapshotId: 1, status: "accepted" }],
      });
    });

    const result = await runCli(
      [
        "diff",
        "apply",
        "root-1",
        "--branch=branch-1",
        "--event-id=retry-1",
        "--created-at=1725000000000",
        "--insert=0:hello",
        "--base=http://example.test",
        "--json",
      ],
      { fetch: fetchImpl, stdout: (text) => stdout.push(text) },
    );

    expect(result).toEqual({ exitCode: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toEqual({
      version: 1,
      events: [
        expect.objectContaining({
          eventId: "retry-1",
          createdAt: 1_725_000_000_000,
          ops: [{ type: "insert", start: 0, end: 0, text: "hello" }],
        }),
      ],
    });
    expect(JSON.parse(stdout[0]!)).toMatchObject({ accepted: 1 });
  });

  it.each([
    [["--event-id=retry-1"], "Provide --event-id and --created-at together when retrying a diff."],
    [["--created-at=1725000000000"], "Provide --event-id and --created-at together when retrying a diff."],
    [["--event-id= retry-1", "--created-at=1"], "--event-id must be 1-120 characters without surrounding whitespace."],
    [["--event-id=retry-1", "--created-at=-1"], "--created-at must be a non-negative integer."],
    [["--event-id", "--created-at"], "--event-id and --created-at require values."],
  ])("rejects %j before network I/O", async (identityFlags, error) => {
    const stderr: string[] = [];
    const fetchImpl = jest.fn<typeof fetch>();
    const args = [
      "diff",
      "apply",
      "root-1",
      "--branch=branch-1",
      ...identityFlags,
      "--insert=0:hello",
      "--base=http://example.test",
      "--json",
    ];
    const result = await runCli(args, {
      fetch: fetchImpl,
      stderr: (text) => stderr.push(text),
    });

    expect(result).toEqual({ exitCode: 1 });
    expect(JSON.parse(stderr[0]!)).toMatchObject({ error });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

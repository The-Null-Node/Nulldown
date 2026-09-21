import { jest } from "@jest/globals";
import { runCli, type CliFetch } from "./index";

describe("CLI diff replace", () => {
  it("sends the fetched event cursor and returns nonzero when verification fails", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    let contentReads = 0;
    let postedEnvelope: unknown;
    const fetchImpl = jest.fn<CliFetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/branches/root-1/branch-1/content") {
        contentReads += 1;
        return Response.json({
          rootDropId: "root-1",
          branchId: "branch-1",
          snapshotId: contentReads - 1,
          headEventSeq: contentReads - 1,
          content: contentReads === 1 ? "before" : "unexpected",
        });
      }
      if (url.pathname === "/api/diff/root-1" && init?.method === "POST") {
        postedEnvelope = JSON.parse(String(init.body));
        const eventId = (postedEnvelope as {
          events: Array<{ eventId: string }>;
        }).events[0]?.eventId;
        return Response.json({
          accepted: 1,
          deduplicated: 0,
          branchId: "branch-1",
          snapshotId: 1,
          totalStored: 1,
          acknowledgements: [
            {
              eventId,
              seq: 1,
              snapshotId: 1,
              status: "accepted",
            },
          ],
        });
      }
      throw new Error(`Unexpected request: ${init?.method || "GET"} ${url}`);
    });

    const result = await runCli(
      [
        "diff",
        "replace",
        "root-1",
        "--branch=branch-1",
        "--to-file=-",
        '--metadata={"kind":"agent.edit","intent":"Replace"}',
        "--base=http://example.test",
        "--json",
      ],
      {
        fetch: fetchImpl,
        readStdin: async () => "after",
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text),
      },
    );

    expect(result).toEqual({ exitCode: 1 });
    expect(stdout).toEqual([]);
    expect(stderr).toHaveLength(1);
    expect(JSON.parse(stderr[0]!)).toEqual({
      error:
        "Branch replacement verification failed after the server response. Refresh before retrying.",
      code: "command_failed",
    });
    expect(postedEnvelope).toEqual({
      version: 1,
      events: [
        expect.objectContaining({
          metadata: {
            kind: "agent.edit",
            intent: "Replace",
            followsSeq: 0,
          },
        }),
      ],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("returns the structured stale predecessor conflict without verifying", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const fetchImpl = jest.fn<CliFetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/branches/root-1/branch-1/content") {
        return Response.json({
          rootDropId: "root-1",
          branchId: "branch-1",
          snapshotId: 3,
          headEventSeq: 7,
          content: "before",
        });
      }
      if (url.pathname === "/api/diff/root-1" && init?.method === "POST") {
        return Response.json(
          {
            error:
              "Branch diff predecessor no longer matches the current head. Refresh and try again.",
            code: "diff_predecessor_mismatch",
          },
          { status: 409 },
        );
      }
      throw new Error(`Unexpected request: ${init?.method || "GET"} ${url}`);
    });

    const result = await runCli(
      [
        "diff",
        "replace",
        "root-1",
        "--branch=branch-1",
        "--to-file=-",
        "--base=http://example.test",
        "--json",
      ],
      {
        fetch: fetchImpl,
        readStdin: async () => "after",
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text),
      },
    );

    expect(result).toEqual({ exitCode: 1 });
    expect(stdout).toEqual([]);
    expect(JSON.parse(stderr[0]!)).toEqual({
      error:
        "Branch diff predecessor no longer matches the current head. Refresh and try again.",
      code: "diff_predecessor_mismatch",
      status: 409,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not claim a branch replacement without a durable acknowledgement", async () => {
    const stderr: string[] = [];
    const fetchImpl = jest.fn<CliFetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/branches/root-1/branch-1/content") {
        return Response.json({
          rootDropId: "root-1",
          branchId: "branch-1",
          snapshotId: 0,
          headEventSeq: -1,
          content: "before",
        });
      }
      if (url.pathname === "/api/diff/root-1" && init?.method === "POST") {
        return Response.json({ accepted: 1 });
      }
      throw new Error(`Unexpected request: ${init?.method || "GET"} ${url}`);
    });

    const result = await runCli(
      [
        "diff",
        "replace",
        "root-1",
        "--branch=branch-1",
        "--to-file=-",
        "--base=http://example.test",
        "--json",
      ],
      {
        fetch: fetchImpl,
        readStdin: async () => "after",
        stderr: (text) => stderr.push(text),
      },
    );

    expect(result).toEqual({ exitCode: 1 });
    expect(JSON.parse(stderr[0]!)).toEqual({
      error:
        "Diff response did not include a durable acknowledgement. Upgrade the server before retrying.",
      code: "command_failed",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("rejects retry identity flags because replacement replay is not immutable", async () => {
    const stderr: string[] = [];
    const fetchImpl = jest.fn<CliFetch>();

    const result = await runCli(
      [
        "diff",
        "replace",
        "root-1",
        "--branch=branch-1",
        "--to-file=-",
        "--event-id=retry-1",
        "--created-at=1725000000000",
        "--base=http://example.test",
        "--json",
      ],
      {
        fetch: fetchImpl,
        readStdin: async () => "after",
        stderr: (text) => stderr.push(text),
      },
    );

    expect(result).toEqual({ exitCode: 1 });
    expect(JSON.parse(stderr[0]!)).toEqual({
      error:
        "nd diff replace cannot safely replay a generated diff. Save and retry the exact envelope with nd diff event or nd diff batch.",
      code: "command_failed",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a partial retry identity before reading the branch", async () => {
    const stderr: string[] = [];
    const fetchImpl = jest.fn<CliFetch>();

    const result = await runCli(
      [
        "diff",
        "replace",
        "root-1",
        "--branch=branch-1",
        "--to-file=-",
        "--created-at=1725000000000",
        "--base=http://example.test",
        "--json",
      ],
      {
        fetch: fetchImpl,
        readStdin: async () => "after",
        stderr: (text) => stderr.push(text),
      },
    );

    expect(result).toEqual({ exitCode: 1 });
    expect(JSON.parse(stderr[0]!)).toEqual({
      error: "Provide --event-id and --created-at together when retrying a diff.",
      code: "command_failed",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("requires a cursor before replacing an existing branch", async () => {
    const stderr: string[] = [];
    const fetchImpl = jest.fn<CliFetch>(async () =>
      Response.json({
        rootDropId: "root-1",
        branchId: "branch-1",
        snapshotId: 3,
        content: "before",
      }),
    );

    const result = await runCli(
      [
        "diff",
        "replace",
        "root-1",
        "--branch=branch-1",
        "--to-file=-",
        "--base=http://example.test",
        "--json",
      ],
      {
        fetch: fetchImpl,
        readStdin: async () => "after",
        stderr: (text) => stderr.push(text),
      },
    );

    expect(result).toEqual({ exitCode: 1 });
    expect(JSON.parse(stderr[0]!)).toEqual({
      error:
        "Branch replacement requires a current event cursor. Upgrade the branch server and refresh before retrying.",
      code: "command_failed",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects --from-file content that differs from the fetched branch", async () => {
    const stderr: string[] = [];
    const readStdin = jest
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("stale")
      .mockResolvedValueOnce("after");
    const fetchImpl = jest.fn<CliFetch>(async () =>
      Response.json({
        rootDropId: "root-1",
        branchId: "branch-1",
        snapshotId: 3,
        headEventSeq: 7,
        content: "before",
      }),
    );

    const result = await runCli(
      [
        "diff",
        "replace",
        "root-1",
        "--branch=branch-1",
        "--from-file=-",
        "--to-file=-",
        "--base=http://example.test",
        "--json",
      ],
      { fetch: fetchImpl, readStdin, stderr: (text) => stderr.push(text) },
    );

    expect(result).toEqual({ exitCode: 1 });
    expect(JSON.parse(stderr[0]!)).toEqual({
      error:
        "Branch replacement --from-file content does not match the current branch. Refresh before retrying.",
      code: "command_failed",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

import { jest } from "@jest/globals";
import { runCli } from "./index";

describe("CLI branch promote", () => {
  it("forwards the fenced retry identity unchanged", async () => {
    const stdout: string[] = [];
    const fetchImpl = jest.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(
        "http://example.test/api/branches/root-1/branch-1/promote",
      );
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({
        expectedSnapshotId: 4,
        idempotencyKey: "promotion-4",
      });
      return Response.json({
        dropId: "promoted-1",
        url: "http://example.test/d/promot",
        rootDropId: "root-1",
        branchId: "branch-1",
        snapshotId: 4,
      });
    });

    const result = await runCli(
      [
        "branch",
        "promote",
        "root-1",
        "branch-1",
        "--expected-snapshot=4",
        "--idempotency-key=promotion-4",
        "--base=http://example.test",
        "--json",
      ],
      { fetch: fetchImpl, stdout: (text) => stdout.push(text) },
    );

    expect(result).toEqual({ exitCode: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(stdout[0]!)).toMatchObject({ dropId: "promoted-1" });
  });

  it("requires the immutable promotion identity before network I/O", async () => {
    const stderr: string[] = [];
    const fetchImpl = jest.fn<typeof fetch>();

    const result = await runCli(
      [
        "branch",
        "promote",
        "root-1",
        "branch-1",
        "--expected-snapshot=4",
        "--base=http://example.test",
        "--json",
      ],
      { fetch: fetchImpl, stderr: (text) => stderr.push(text) },
    );

    expect(result).toEqual({ exitCode: 1 });
    expect(JSON.parse(stderr[0]!)).toEqual({
      error:
        "Usage: nd branch promote <rootId> <branchId> --expected-snapshot <n> --idempotency-key <key>",
      code: "command_failed",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

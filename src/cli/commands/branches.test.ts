import { createBranchCommand } from "./branches";
import { jest } from "@jest/globals";
import { parseArgs } from "../core/args";

describe("branch promote command", () => {
  it("forwards the fenced promotion identity unchanged", async () => {
    const promote = jest.fn(async () => ({ url: "https://nulldown.test/d/promoted" }));
    const print = jest.fn();
    const command = createBranchCommand({
      runtime: { branches: { promote } } as never,
      print,
      parseMetadata: async () => undefined,
      parseJsonLoose: () => null,
      defaultDocumentResolverId: "nulldown.resolved.document",
    });

    await command.run({
      config: {},
      args: parseArgs([
        "branch",
        "promote",
        "root-1",
        "branch-1",
        "--expected-snapshot=4",
        "--idempotency-key=promotion-4",
      ]),
    });

    expect(promote).toHaveBeenCalledWith({
      rootId: "root-1",
      branchId: "branch-1",
      expectedSnapshotId: 4,
      idempotencyKey: "promotion-4",
    });
    expect(print).toHaveBeenCalledWith(
      { url: "https://nulldown.test/d/promoted" },
      "promoted https://nulldown.test/d/promoted",
    );
  });

  it("rejects incomplete promotion identities before dispatch", async () => {
    const promote = jest.fn();
    const command = createBranchCommand({
      runtime: { branches: { promote } } as never,
      print: () => undefined,
      parseMetadata: async () => undefined,
      parseJsonLoose: () => null,
      defaultDocumentResolverId: "nulldown.resolved.document",
    });

    await expect(
      command.run({
        config: {},
        args: parseArgs([
          "branch",
          "promote",
          "root-1",
          "branch-1",
          "--expected-snapshot=4",
        ]),
      }),
    ).rejects.toThrow(
      "Usage: nd branch promote <rootId> <branchId> --expected-snapshot <n> --idempotency-key <key>",
    );
    expect(promote).not.toHaveBeenCalled();
  });
});

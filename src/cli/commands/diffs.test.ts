import { jest } from "@jest/globals";
import { parseArgs } from "../core/args";
import { createDiffCommand } from "./diffs";

describe("diff command", () => {
  it("rejects an unsafe retry timestamp before reading or posting", async () => {
    const get = jest.fn();
    const postEnvelope = jest.fn();
    const command = createDiffCommand({
      runtime: {
        drops: { get },
        diffs: { postEnvelope },
      },
    } as never);

    await expect(
      command.run({
        config: {},
        args: parseArgs([
          "diff",
          "apply",
          "drop-1",
          "--insert=0:hello",
          "--event-id=retry-1",
          `--created-at=${Number.MAX_SAFE_INTEGER + 1}`,
        ]),
      }),
    ).rejects.toThrow("--created-at must be a non-negative safe integer.");

    expect(get).not.toHaveBeenCalled();
    expect(postEnvelope).not.toHaveBeenCalled();
  });
});

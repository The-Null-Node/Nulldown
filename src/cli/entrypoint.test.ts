import { spawnSync } from "node:child_process";
import packageJson from "../../package.json";

const runCli = (args: string[]) =>
  spawnSync("bun", ["./bin/nulldown.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      ND_CONFIG: "",
      ND_TOKEN: "",
      ND_DIFF_AUTH_TOKEN: "",
      ND_REQUEST_TIMEOUT_MS: "",
    },
  });

describe("CLI executable entrypoint", () => {
  it("maps returned success and failure results to process exit codes", () => {
    const version = runCli(["--version"]);
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toBe(packageJson.version);
    expect(version.stderr).toBe("");

    const failure = runCli(["unknown-command", "--json"]);
    expect(failure.status).toBe(1);
    expect(failure.stdout).toBe("");
    expect(JSON.parse(failure.stderr)).toEqual({
      error: "Unknown command: unknown-command",
      code: "unknown_command",
    });
  });

  it("emits parseable NDJSON diagnostics as a complete stderr stream", () => {
    const failure = runCli(["unknown-command", "--json", "--verbose"]);

    expect(failure.status).toBe(1);
    expect(failure.stdout).toBe("");
    const records = failure.stderr
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records).toEqual([
      expect.objectContaining({
        type: "diagnostic",
        event: "command.start",
        command: "unknown",
      }),
      expect.objectContaining({
        type: "diagnostic",
        event: "command.error",
        command: "unknown",
        code: "unknown_command",
      }),
      {
        error: "Unknown command: unknown-command",
        code: "unknown_command",
      },
    ]);
  });
});

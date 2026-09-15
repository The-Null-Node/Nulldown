import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, type RunCliDependencies } from "./index";

const captureOutput = (): {
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
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
  };
};

describe("runCli", () => {
  it("returns exit 1 and preserves JSON stderr", async () => {
    const output = captureOutput();

    const result = await runCli(
      ["unknown-command", "--json"],
      output.dependencies,
    );

    expect(result).toEqual({ exitCode: 1 });
    expect(output.stdout).toEqual([]);
    expect(output.stderr).toHaveLength(1);
    expect(JSON.parse(output.stderr[0]!)).toEqual({
      error: "Unknown command: unknown-command",
      code: "unknown_command",
    });
  });

  it.each(["not-a-number", "0.4", "2147483648"])(
    "returns a structured configuration error for timeout %s",
    async (timeout) => {
      const output = captureOutput();

      const result = await runCli(
        ["list", "--json", "--timeout-ms", timeout],
        output.dependencies,
      );

      expect(result).toEqual({ exitCode: 1 });
      expect(output.stdout).toEqual([]);
      expect(JSON.parse(output.stderr[0]!)).toEqual({
        error:
          "Request timeout must be an integer from 1 to 2147483647.",
        code: "invalid_request_timeout",
      });
    },
  );

  it("preserves config-file JSON mode when configuration is invalid", async () => {
    const output = captureOutput();
    const directory = await mkdtemp(join(tmpdir(), "nulldown-cli-config-"));
    const configPath = join(directory, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({ json: true, requestTimeoutMs: true }),
      "utf8",
    );

    try {
      const result = await runCli(
        ["list", "--config", configPath],
        output.dependencies,
      );

      expect(result).toEqual({ exitCode: 1 });
      expect(output.stdout).toEqual([]);
      expect(JSON.parse(output.stderr[0]!)).toEqual({
        error:
          "Request timeout must be an integer from 1 to 2147483647.",
        code: "invalid_request_timeout",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

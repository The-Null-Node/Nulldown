import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const fail = (message: string, details: Record<string, unknown> = {}): never => {
  console.error(message);
  console.error(JSON.stringify(details, null, 2));
  process.exit(1);
};

const run = (command: string, args: string[]) => {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, ND_BASE_URL: process.env.ND_BASE_URL ?? "https://nulldown.app" },
  });
  if (result.status !== 0) {
    fail("Command failed.", {
      command,
      args,
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }
  return result;
};

const cliPath = "dist/nulldown";
const mcpPath = "dist/nulldown-mcp";
const packageVersion = (JSON.parse(readFileSync("package.json", "utf8")) as {
  version: string;
}).version;

if (!existsSync(cliPath) || !existsSync(mcpPath)) {
  fail("Compiled binaries are missing. Run bun run bin:build:current first.", {
    cliPath,
    mcpPath,
  });
}

run(cliPath, ["--help"]);
const version = run(cliPath, ["--version"]);
if (version.stdout.trim() !== packageVersion) {
  fail("Compiled CLI version output did not match package metadata.", {
    expected: packageVersion,
    actual: version.stdout.trim(),
  });
}
const query = run(cliPath, [
  "--base=https://nulldown.app",
  "branch",
  "query",
  "1wrhjx8Wzk67",
  "clone_account:91c993ac-2c8c-46d6-aaec-5d31e610a2b7",
  "--query",
  "priority",
  "--top",
  "1",
  "--json",
]);
const parsed = JSON.parse(query.stdout) as { rootDropId?: string; nodes?: unknown[] };
if (parsed.rootDropId !== "1wrhjx8Wzk67" || !Array.isArray(parsed.nodes)) {
  fail("Compiled CLI branch query returned unexpected payload.", { parsed });
}

run("bun", ["run", "scripts/smoke-mcp-stdio.ts", mcpPath]);

console.log(
  JSON.stringify(
    {
      cliPath,
      mcpPath,
      cliBranchQueryNodes: parsed.nodes.length,
    },
    null,
    2,
  ),
);

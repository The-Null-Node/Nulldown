import { spawnSync } from "node:child_process";
import { accessSync, constants, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = process.cwd();
const packageDir = join(repoRoot, "packages", "nulldown-mcp");

const fail = (message: string, details: Record<string, unknown> = {}): never => {
  console.error(message);
  console.error(JSON.stringify(details, null, 2));
  process.exit(1);
};

const run = (command: string, args: string[], cwd: string) => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ND_BASE_URL: process.env.ND_BASE_URL ?? "https://nulldown.app" },
  });
  if (result.status !== 0) {
    fail("Command failed.", {
      command,
      args,
      cwd,
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }
  return result;
};

const tempRoot = mkdtempSync(join(tmpdir(), "nulldown-mcp-package-"));
try {
  const basePackResult = run("npm", ["pack", "--json", "--pack-destination", tempRoot], repoRoot);
  const [basePack] = JSON.parse(basePackResult.stdout) as Array<{ filename: string }>;
  if (!basePack?.filename) {
    fail("npm pack did not return a base package filename.", { stdout: basePackResult.stdout });
  }

  const mcpPackResult = run("npm", ["pack", "--json", "--pack-destination", tempRoot], packageDir);
  const [mcpPack] = JSON.parse(mcpPackResult.stdout) as Array<{ filename: string }>;
  if (!mcpPack?.filename) {
    fail("npm pack did not return an MCP package filename.", { stdout: mcpPackResult.stdout });
  }

  const installDir = join(tempRoot, "install");
  mkdirSync(installDir);
  writeFileSync(join(installDir, "package.json"), '{"type":"module","private":true}\n');

  const baseTarballPath = join(tempRoot, basePack.filename);
  const mcpTarballPath = join(tempRoot, mcpPack.filename);
  run("npm", ["install", "--no-audit", "--no-fund", baseTarballPath, mcpTarballPath], installDir);

  const binPath = join(installDir, "node_modules", ".bin", "nulldown-mcp");
  const altBinPath = join(installDir, "node_modules", ".bin", "nd-mcp");
  const packageBinPath = join(
    installDir,
    "node_modules",
    "@thenullnode",
    "nulldown-mcp",
    "bin",
    "nulldown-mcp",
  );
  accessSync(binPath, constants.X_OK);
  accessSync(altBinPath, constants.X_OK);
  accessSync(packageBinPath, constants.X_OK);
  run("bun", ["run", join(repoRoot, "scripts", "smoke-mcp-stdio.ts"), binPath], installDir);

  console.log(
    JSON.stringify(
      {
        package: "@thenullnode/nulldown-mcp",
        baseTarball: baseTarballPath,
        mcpTarball: mcpTarballPath,
        binPath,
        altBinPath,
        packageBinPath,
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

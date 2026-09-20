import { spawnSync } from "node:child_process";
import { accessSync, constants, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = process.cwd();
const packageDir = join(repoRoot, "packages", "nulldown-mcp");
const packageSmokeEnvironment = { ...process.env };
for (const name of [
  "ND_BASE_URL",
  "ND_AUTH_FILE",
  "ND_TOKEN",
  "ND_DIFF_AUTH_TOKEN",
  "DIFF_WEBHOOK_SECRET",
  "VITE_PROVIDER_ENCRYPTION_PUBLIC_JWK",
]) {
  delete packageSmokeEnvironment[name];
}

class PackageSmokeFailure extends Error {
  constructor(
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const fail = (message: string, details: Record<string, unknown> = {}): never => {
  throw new PackageSmokeFailure(message, details);
};

const run = (command: string, args: string[], cwd: string) => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: packageSmokeEnvironment,
  });
  if (result.status !== 0) {
    fail("Command failed.", {
      command,
      args,
      cwd,
      status: result.status,
      error: result.error?.message,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }
  return result;
};

const main = (): void => {
  const tempRoot = mkdtempSync(join(tmpdir(), "nulldown-mcp-package-"));
  try {
    const basePackResult = run(
      "npm",
      ["pack", "--json", "--pack-destination", tempRoot],
      repoRoot,
    );
    const [basePack] = JSON.parse(basePackResult.stdout) as Array<{ filename: string }>;
    if (!basePack?.filename) {
      fail("npm pack did not return a base package filename.", { stdout: basePackResult.stdout });
    }

    const mcpPackResult = run(
      "npm",
      ["pack", "--json", "--pack-destination", tempRoot],
      packageDir,
    );
    const [mcpPack] = JSON.parse(mcpPackResult.stdout) as Array<{ filename: string }>;
    if (!mcpPack?.filename) {
      fail("npm pack did not return an MCP package filename.", { stdout: mcpPackResult.stdout });
    }

    const installDir = join(tempRoot, "install");
    mkdirSync(installDir);
    writeFileSync(join(installDir, "package.json"), '{"type":"module","private":true}\n');

    const baseTarballPath = join(tempRoot, basePack.filename);
    const mcpTarballPath = join(tempRoot, mcpPack.filename);
    run(
      "npm",
      ["install", "--offline", "--no-audit", "--no-fund", baseTarballPath, mcpTarballPath],
      installDir,
    );

    const importCheckPath = join(installDir, "check-imports.mjs");
    writeFileSync(
      importCheckPath,
      `${JSON.stringify([
        ["@thenullnode/nulldown-mcp", ["createNulldownMcpServer", "runNulldownMcpServer"]],
        ["@thenullnode/nulldown-mcp/server", ["createNulldownMcpServer", "runNulldownMcpServer"]],
        ["@thenullnode/nulldown/client", ["DEFAULT_NULLDOWN_BASE_URL", "NulldownClient", "createNulldownClient"]],
        ["@thenullnode/nulldown/server/runtime", ["createNulldownServerRuntime"]],
        ["@thenullnode/nulldown/drop/authoring", ["sealDropForAuthoring"]],
        ["@thenullnode/nulldown/drop/diff", ["isDropDiffOp"]],
        ["@thenullnode/nulldown/nulledit/types", ["DiffOp"]],
        ["@thenullnode/nulldown/auth/cliCredential", ["createFileCliCredentialTokenProvider"]],
        ["@thenullnode/nulldown/auth/cliDevice", []],
      ])};
for (const [specifier, expectedExports] of expectations) {
  const imported = await import(specifier);
  const missingExports = expectedExports.filter((name) => !(name in imported));
  if (missingExports.length > 0) {
    console.error(JSON.stringify({ specifier, missingExports }));
    throw new Error("Packed package import check failed.");
  }
}
console.log(JSON.stringify({ checkedImports: expectations.map(([specifier]) => specifier) }));
`.replace(/^/, "const expectations = "),
    );
    const importCheckResult = run("bun", [importCheckPath], installDir);

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
    run(
      "bun",
      ["run", join(repoRoot, "scripts", "smoke-mcp-stdio.ts"), binPath],
      installDir,
    );
    run(
      "bun",
      ["run", join(repoRoot, "scripts", "smoke-mcp-stdio.ts"), altBinPath],
      installDir,
    );

    console.log(
      JSON.stringify(
        {
          package: "@thenullnode/nulldown-mcp",
          baseTarball: baseTarballPath,
          mcpTarball: mcpTarballPath,
          binPath,
          altBinPath,
          packageBinPath,
          importCheck: JSON.parse(importCheckResult.stdout),
          executedAliases: ["nulldown-mcp", "nd-mcp"],
        },
        null,
        2,
      ),
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
};

try {
  main();
} catch (error) {
  const packageFailure = error instanceof PackageSmokeFailure ? error : null;
  console.error(packageFailure?.message ?? "MCP package smoke failed.");
  console.error(
    JSON.stringify(
      packageFailure?.details ?? {
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
}

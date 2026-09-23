import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface PackFile {
  path: string;
}

interface PackEntry {
  files: PackFile[];
}

interface PackageJson {
  name?: string;
  bin?: Record<string, string>;
  dependencies?: Record<string, string>;
}

const packageDir = fileURLToPath(
  new URL("../packages/nulldown-mcp/", import.meta.url),
);
const legacyRootEntrypoint = new URL("../bin/nulldown-mcp.ts", import.meta.url);
const legacyRootSourceDir = new URL("../src/mcp/", import.meta.url);

const fail = (message: string, details: Record<string, unknown>): never => {
  console.error(message);
  console.error(JSON.stringify(details, null, 2));
  process.exit(1);
};

const packageJson = JSON.parse(
  readFileSync(new URL("../packages/nulldown-mcp/package.json", import.meta.url), "utf8"),
) as PackageJson;

const binEntries = packageJson.bin ?? {};
const expectedCoreRange = ">=0.0.8 <0.1.0";
if (packageJson.dependencies?.["@thenullnode/nulldown"] !== expectedCoreRange) {
  fail("MCP requires the core release that provides bounded strategy reads.", {
    expectedCoreRange,
    actualCoreRange: packageJson.dependencies?.["@thenullnode/nulldown"],
  });
}
const binKeys = Object.keys(binEntries);
const expectedBins = ["nd-mcp", "nulldown-mcp"];
const expectedBinTarget = "bin/nulldown-mcp";
const missingBins = expectedBins.filter((bin) => !binKeys.includes(bin));
const unexpectedBins = binKeys.filter((bin) => !expectedBins.includes(bin));
const invalidBinTargets = expectedBins.filter(
  (bin) => binEntries[bin] !== expectedBinTarget,
);
const requiredDependencies = [
  "@modelcontextprotocol/sdk",
  "@thenullnode/nulldown",
  "zod",
];
const missingDependencies = requiredDependencies.filter(
  (dependency) => !(dependency in (packageJson.dependencies ?? {})),
);
const requiresAuthoringExport =
  packageJson.dependencies?.["@thenullnode/nulldown"] === expectedCoreRange;

const pack = spawnSync("npm", ["pack", "--dry-run", "--json"], {
  cwd: packageDir,
  encoding: "utf8",
});

if (pack.status !== 0) {
  fail("npm pack --dry-run failed for MCP package.", {
    status: pack.status,
    stderr: pack.stderr,
    stdout: pack.stdout,
  });
}

const [entry] = JSON.parse(pack.stdout) as PackEntry[];
const files = new Set(entry.files.map((file) => file.path));
const requiredFiles = [
  "README.md",
  "bin/nulldown-mcp",
  "bin/nulldown-mcp.ts",
  "src/diff-schemas.ts",
  "src/logging.ts",
  "src/server.ts",
  "src/tooling.ts",
  "src/tools/branch-tools.ts",
  "src/tools/drop-tools.ts",
  "src/tools/index.ts",
  "src/tools/memory-tools.ts",
  "src/tools/strategy-tools.ts",
];
const missingFiles = requiredFiles.filter((file) => !files.has(file));
const privateCredentialPath = new URL(
  "../packages/nulldown-mcp/src/cliCredential.ts",
  import.meta.url,
);
const hasPrivateCredentialSource = existsSync(privateCredentialPath);
const packsPrivateCredentialSource = files.has("src/cliCredential.ts");
const hasLegacyRootEntrypoint = existsSync(legacyRootEntrypoint);
const hasLegacyRootSourceDir = existsSync(legacyRootSourceDir);
const packageTooling = readFileSync(
  new URL("../packages/nulldown-mcp/src/tooling.ts", import.meta.url),
  "utf8",
);
const credentialImport = packageTooling.match(
  /import\s*\{([^}]*)\}\s*from\s*"@thenullnode\/nulldown\/auth\/cliCredential";/u,
);
const credentialImports = new Set(
  credentialImport?.[1].split(",").map((name) => name.trim()).filter(Boolean) ?? [],
);
const requiredCredentialImports = [
  "createFileCliCredentialTokenProvider",
  "normalizeCliCredentialBaseUrl",
  "readCliCredential",
];
const missingCredentialImports = requiredCredentialImports.filter(
  (name) => !credentialImports.has(name),
);
const usesAuthoringExport = packageTooling.includes(
  'from "@thenullnode/nulldown/drop/authoring"',
);
const hasLocalAuthoringImplementation = [
  "const serializeCanonicalJson",
  "const toBase64",
  "const sealDropForAuthoring",
  "const isDropEncryptionPublicJwk",
].some((marker) => packageTooling.includes(marker));

if (
  packageJson.name !== "@thenullnode/nulldown-mcp" ||
  missingBins.length ||
  unexpectedBins.length ||
  invalidBinTargets.length ||
  missingDependencies.length ||
  !requiresAuthoringExport ||
  missingFiles.length ||
  hasPrivateCredentialSource ||
  packsPrivateCredentialSource ||
  hasLegacyRootEntrypoint ||
  hasLegacyRootSourceDir ||
  missingCredentialImports.length ||
  !usesAuthoringExport ||
  hasLocalAuthoringImplementation
) {
  fail("MCP package boundary check failed.", {
    packageName: packageJson.name,
    missingBins,
    unexpectedBins,
    invalidBinTargets,
    missingDependencies,
    requiresAuthoringExport,
    missingFiles,
    hasPrivateCredentialSource,
    packsPrivateCredentialSource,
    hasLegacyRootEntrypoint,
    hasLegacyRootSourceDir,
    missingCredentialImports,
    usesAuthoringExport,
    hasLocalAuthoringImplementation,
  });
}

console.log(
  JSON.stringify(
    {
      packageName: packageJson.name,
      bins: binKeys,
      dependencies: requiredDependencies,
      coreRange: expectedCoreRange,
      fileCount: files.size,
      checked: {
        requiredFiles,
        requiredCredentialImports,
        privateCredentialSourceAbsent: true,
        legacyRootEntrypointAbsent: true,
        legacyRootSourceDirAbsent: true,
      },
    },
    null,
    2,
  ),
);

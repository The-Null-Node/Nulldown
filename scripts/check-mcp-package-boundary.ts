import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

const fail = (message: string, details: Record<string, unknown>): never => {
  console.error(message);
  console.error(JSON.stringify(details, null, 2));
  process.exit(1);
};

const packageJson = JSON.parse(
  readFileSync(new URL("../packages/nulldown-mcp/package.json", import.meta.url), "utf8"),
) as PackageJson;

const binEntries = packageJson.bin ?? {};
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
  packageJson.dependencies?.["@thenullnode/nulldown"] === ">=0.0.7 <0.1.0";

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
    "src/diffSchemas.ts",
    "src/cliCredential.ts",
    "src/logging.ts",
  "src/server.ts",
  "src/tooling.ts",
  "src/tools/branchTools.ts",
  "src/tools/dropTools.ts",
  "src/tools/index.ts",
  "src/tools/memoryTools.ts",
  "src/tools/strategyTools.ts",
];
const missingFiles = requiredFiles.filter((file) => !files.has(file));
const credentialAdapter = readFileSync(
  new URL("../packages/nulldown-mcp/src/cliCredential.ts", import.meta.url),
  "utf8",
);
const packageTooling = readFileSync(
  new URL("../packages/nulldown-mcp/src/tooling.ts", import.meta.url),
  "utf8",
);
const preservesAuthoringOnRefresh = credentialAdapter.includes("mergeCliCredentialAuthoring");
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
  !preservesAuthoringOnRefresh ||
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
    preservesAuthoringOnRefresh,
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
      fileCount: files.size,
      checked: {
        requiredFiles,
      },
    },
    null,
    2,
  ),
);

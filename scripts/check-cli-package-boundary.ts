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
  bin?: Record<string, string>;
  dependencies?: Record<string, string>;
}

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

const fail = (message: string, details: Record<string, unknown>): never => {
  console.error(message);
  console.error(JSON.stringify(details, null, 2));
  process.exit(1);
};

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as PackageJson;

const binEntries = packageJson.bin ?? {};
const binKeys = Object.keys(binEntries);
const expectedBins = ["nd", "nulldown"];
const expectedBinTarget = "bin/nulldown";
const missingBins = expectedBins.filter((bin) => !binKeys.includes(bin));
const unexpectedBins = binKeys.filter((bin) => !expectedBins.includes(bin));
const invalidBinTargets = expectedBins.filter(
  (bin) => binEntries[bin] !== expectedBinTarget,
);
const forbiddenRuntimeDependencies = [
  "@base-ui/react",
  "@fontsource-variable/geist",
  "@modelcontextprotocol/sdk",
  "@types/d3",
  "class-variance-authority",
  "clsx",
  "d3",
  "katex",
  "lucide-react",
  "mermaid",
  "react-katex",
  "react-markdown",
  "react-router-dom",
  "react-syntax-highlighter",
  "rehype-katex",
  "rehype-raw",
  "rehype-sanitize",
  "remark-gfm",
  "remark-math",
  "shadcn",
  "tailwind-merge",
  "tw-animate-css",
  "unified",
  "vfile",
  "vfile-message",
  "zustand",
];
const forbiddenDependencies = forbiddenRuntimeDependencies.filter(
  (dependency) => dependency in (packageJson.dependencies ?? {}),
);

const pack = spawnSync("npm", ["pack", "--dry-run", "--json"], {
  cwd: repoRoot,
  encoding: "utf8",
});

if (pack.status !== 0) {
  fail("npm pack --dry-run failed.", {
    status: pack.status,
    stderr: pack.stderr,
    stdout: pack.stdout,
  });
}

const [entry] = JSON.parse(pack.stdout) as PackEntry[];
const files = new Set(entry.files.map((file) => file.path));
const forbiddenFiles = [...files].filter(
  (file) => file === "bin/nulldown-mcp.ts" || file.startsWith("src/mcp/"),
);
const requiredFiles = ["bin/nulldown", "bin/nulldown.ts", "src/cli/index.ts"];
const missingFiles = requiredFiles.filter((file) => !files.has(file));

if (
  missingBins.length ||
  unexpectedBins.length ||
  invalidBinTargets.length ||
  forbiddenDependencies.length ||
  forbiddenFiles.length ||
  missingFiles.length
) {
  fail("CLI package boundary check failed.", {
    missingBins,
    unexpectedBins,
    invalidBinTargets,
    forbiddenDependencies,
    forbiddenFiles,
    missingFiles,
  });
}

console.log(
  JSON.stringify(
    {
      bins: binKeys,
      fileCount: files.size,
      checked: {
        requiredFiles,
        forbiddenDependencies: forbiddenRuntimeDependencies,
        forbiddenPatterns: ["bin/nulldown-mcp.ts", "src/mcp/"],
      },
    },
    null,
    2,
  ),
);

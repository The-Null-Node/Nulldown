import { spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

interface PackFile {
  mode?: number;
  path: string;
}

interface PackEntry {
  files: PackFile[];
  name?: string;
  version?: string;
}

interface PackageJson {
  bin?: Record<string, string>;
  dependencies?: Record<string, string>;
  exports?: Record<string, unknown>;
  name: string;
  version: string;
}

interface MissingImport {
  importer: string;
  specifier: string;
}

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const packagePath = (path: string): string => relative(repoRoot, path).replaceAll("\\", "/");
const packagePathToAbsolute = (path: string): string => resolve(repoRoot, path);

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
if (!entry) {
  fail("npm pack --dry-run returned no package entry.", { stdout: pack.stdout });
}

const packedFiles = new Map(entry.files.map((file) => [file.path, file]));
const files = new Set(packedFiles.keys());
const forbiddenFiles = [...files].filter(
  (file) => file === "bin/nulldown-mcp.ts" || file.startsWith("src/mcp/"),
);
const exportTargets = Object.values(packageJson.exports ?? {}).flatMap(
  function collectTargets(value: unknown): string[] {
    if (typeof value === "string") return [value];
    if (!value || typeof value !== "object") return [];
    return Object.values(value).flatMap(collectTargets);
  },
).map((path) => path.replace(/^\.\//, ""));
const entryPoints = [
  ...new Set([...Object.values(binEntries), ...exportTargets]),
];
const missingEntryPoints = entryPoints.filter((path) => !files.has(path));
const migrations = readdirSync(join(repoRoot, "migrations"))
  .filter((file) => file.endsWith(".sql"))
  .sort()
  .map((file) => `migrations/${file}`);
const missingMigrations = migrations.filter((path) => !files.has(path));
const executableBins = expectedBins.map((bin) => binEntries[bin]).filter(Boolean);
const nonExecutableBins = executableBins.filter((path) => {
  const mode = packedFiles.get(path)?.mode;
  return mode === undefined || (mode & 0o111) === 0;
});

const resolveLocalImport = (importer: string, specifier: string): string | null => {
  const initial = resolve(dirname(importer), specifier);
  const withoutJsExtension = specifier.endsWith(".js")
    ? initial.slice(0, -".js".length)
    : initial;
  const candidates = [
    initial,
    withoutJsExtension,
    ...[".ts", ".tsx", ".js", ".mjs", ".cjs", ".json"].flatMap((extension) => [
      `${initial}${extension}`,
      `${withoutJsExtension}${extension}`,
    ]),
    ...[".ts", ".tsx", ".js", ".mjs", ".cjs"].flatMap((extension) => [
      join(initial, `index${extension}`),
      join(withoutJsExtension, `index${extension}`),
    ]),
  ];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null;
};

const moduleSpecifiers = (path: string): string[] => {
  if (!/\.(?:[cm]?[jt]sx?)$/.test(path)) return [];
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    false,
  );
  const specifiers = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.add(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.add(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...specifiers];
};

const missingImports: MissingImport[] = [];
const externalRelativeImports: MissingImport[] = [];
const missingClosureFiles = new Set<string>();
const visited = new Set<string>();
const queue = entryPoints.map(packagePathToAbsolute);

while (queue.length) {
  const sourcePath = queue.pop()!;
  if (visited.has(sourcePath)) continue;
  visited.add(sourcePath);

  const relativePath = packagePath(sourcePath);
  if (!relativePath || relativePath.startsWith("../") || isAbsolute(relativePath)) {
    externalRelativeImports.push({ importer: relativePath, specifier: "<entrypoint>" });
    continue;
  }
  if (!existsSync(sourcePath)) {
    missingImports.push({ importer: relativePath, specifier: "<entrypoint>" });
    continue;
  }
  if (!files.has(relativePath)) missingClosureFiles.add(relativePath);

  for (const specifier of moduleSpecifiers(sourcePath)) {
    if (!specifier.startsWith(".")) continue;
    const resolvedPath = resolveLocalImport(sourcePath, specifier);
    if (!resolvedPath) {
      missingImports.push({ importer: relativePath, specifier });
      continue;
    }
    const resolvedRelativePath = packagePath(resolvedPath);
    if (
      !resolvedRelativePath ||
      resolvedRelativePath.startsWith("../") ||
      isAbsolute(resolvedRelativePath)
    ) {
      externalRelativeImports.push({ importer: relativePath, specifier });
      continue;
    }
    queue.push(resolvedPath);
  }
}

const invalidPackIdentity =
  entry.name !== packageJson.name || entry.version !== packageJson.version;

if (
  missingBins.length ||
  unexpectedBins.length ||
  invalidBinTargets.length ||
  forbiddenDependencies.length ||
  forbiddenFiles.length ||
  invalidPackIdentity ||
  missingEntryPoints.length ||
  missingMigrations.length ||
  nonExecutableBins.length ||
  missingImports.length ||
  externalRelativeImports.length ||
  missingClosureFiles.size
) {
  fail("CLI package boundary check failed.", {
    missingBins,
    unexpectedBins,
    invalidBinTargets,
    forbiddenDependencies,
    forbiddenFiles,
    expectedPackIdentity: { name: packageJson.name, version: packageJson.version },
    actualPackIdentity: { name: entry.name, version: entry.version },
    missingEntryPoints,
    missingMigrations,
    nonExecutableBins,
    missingImports,
    externalRelativeImports,
    missingClosureFiles: [...missingClosureFiles].sort(),
  });
}

console.log(
  JSON.stringify(
    {
      bins: binKeys,
      fileCount: files.size,
      closureFileCount: visited.size,
      migrationCount: migrations.length,
      checked: {
        entryPoints,
        forbiddenDependencies: forbiddenRuntimeDependencies,
        forbiddenPatterns: ["bin/nulldown-mcp.ts", "src/mcp/"],
      },
    },
    null,
    2,
  ),
);

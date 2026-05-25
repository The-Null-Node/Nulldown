// scripts/embed.mjs
import { readdir, readFile, writeFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";

const DIST = "dist";
const OUT = "src/__embedded.ts";

async function walk(dir) {
  const out = [];
  for (const name of await readdir(dir)) {
    const p = join(dir, name);
    const s = await stat(p);
    if (s.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

const files = await walk(DIST);
const entries = await Promise.all(
  files.map(async (p) => {
    const rel = relative(DIST, p).replaceAll("\\", "/");
    const b64 = (await readFile(p)).toString("base64");
    return { rel, b64 };
  }),
);

const ts = `// AUTO-GENERATED. Do not edit.
export const embedded = new Map<string, Uint8Array>([
${entries.map(({ rel, b64 }) => `  ["${rel}", Uint8Array.from(atob("${b64}"), c => c.charCodeAt(0))],`).join("\n")}
]);
`;

await writeFile(OUT, ts);
console.log(`Embedded ${entries.length} files -> ${OUT}`);

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../.."),
  out = resolve(root, ".profiling");
await mkdir(resolve(out, "pages-upload"), { recursive: true });
await mkdir(resolve(out, "empty-home"), { recursive: true });
const env = {
  PATH: process.env.PATH!,
  HOME: resolve(out, "empty-home"),
  CI: "true",
  WRANGLER_SEND_METRICS: "false",
  WRANGLER_WRITE_LOGS: "false",
  WRANGLER_LOAD_DOT_ENV: "false",
  CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
};
const args = [
  "node",
  "--require",
  resolve(root, "scripts/profiling/no-external.cjs"),
  resolve(root, "node_modules/wrangler/bin/wrangler.js"),
  "pages",
  "functions",
  "build",
  "--cwd",
  root,
  "--project-directory",
  root,
  "--outfile",
  resolve(out, "pages-upload/_worker.bundle"),
];
const command = Bun.spawn(args, {
  cwd: root,
  env,
  stdout: "pipe",
  stderr: "pipe",
});
const stdout = await new Response(command.stdout).text(),
  stderr = await new Response(command.stderr).text(),
  exit = await command.exited;
await writeFile(resolve(out, "pages-build.log"), stdout + stderr);
if (exit !== 0)
  throw Error("Offline Pages build failed; see .profiling/pages-build.log");
const multipart = await readFile(resolve(out, "pages-upload/_worker.bundle"));
const boundary = multipart.subarray(2, multipart.indexOf("\r\n")).toString();
const form = await new Response(multipart, {
  headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
}).formData();
async function moduleBytes(part: unknown): Promise<Uint8Array> {
  if (
    typeof part !== "object" ||
    part === null ||
    !("arrayBuffer" in part) ||
    typeof part.arrayBuffer !== "function"
  )
    throw Error("Unexpected multipart module body");
  const bytes: unknown = await part.arrayBuffer();
  if (!(bytes instanceof ArrayBuffer))
    throw Error("Unexpected multipart module bytes");
  return new Uint8Array(bytes);
}
let modules = 0;
for (const [name, file] of form.entries())
  if (name !== "metadata") {
    if (typeof file === "string" || !name.endsWith(".js"))
      throw Error("Unexpected Pages module");
    await writeFile(
      resolve(out, "pages-upload/functions.js"),
      await moduleBytes(file),
    );
    modules++;
  }
if (modules !== 1) throw Error("Expected single compiled Pages module");
// Explicit derived diagnostic control, built BEFORE sealing. Never acceptance timings.
if (process.argv.includes("--diagnostic")) {
  const path = resolve(out, "pages-upload/functions.js");
  let text = await readFile(path, "utf8");
  const replaceOnce = (from: string, to: string) => {
    if (text.split(from).length !== 2)
      throw Error("Diagnostic hook drift: " + from);
    text = text.replace(from, to);
  };
  replaceOnce(
    "if (!validBatch(batch)) return;",
    'if (!validBatch(batch)) { console.log(JSON.stringify({diagnostic:"validator-rejected",batch})); return; }',
  );
  replaceOnce(
    "controller.abort();",
    'console.log(JSON.stringify({diagnostic:"export-timer-fired",source,at:Date.now(),abortedBefore:controller.signal.aborted})); controller.abort(); console.log(JSON.stringify({diagnostic:"export-aborted",source,at:Date.now(),abortedAfter:controller.signal.aborted}));',
  );
  replaceOnce(
    "const controller = new AbortController();",
    'const controller = new AbortController(); console.log(JSON.stringify({diagnostic:"export-start",source,at:Date.now()}));',
  );
  await writeFile(path, text);
}
for (const [entry, output] of [
  ["tests/authenticated-entry.ts", "authenticated-entry.js"],
  ["tests/collector-entry.ts", "collector-upload-final/worker.js"],
]) {
  const result = await Bun.build({
    entrypoints: [resolve(root, "scripts/profiling", entry)],
    target: "browser",
    external: ["cloudflare:workers"],
    outdir: resolve(out, output.slice(0, output.lastIndexOf("/") + 1)),
    naming: output.split("/").at(-1)!,
  });
  if (!result.success)
    throw new AggregateError(result.logs, "Local fixture build failed");
}
await writeFile(
  resolve(out, "build-control.json"),
  JSON.stringify(
    {
      diagnostic: process.argv.includes("--diagnostic"),
      acceptanceEligible: !process.argv.includes("--diagnostic"),
      hooks:
        "validator rejection and export timer/abort logging only; no auth/storage edits",
    },
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify({
    offlineBuild: true,
    applicationModules: modules,
    output: ".profiling",
  }),
);

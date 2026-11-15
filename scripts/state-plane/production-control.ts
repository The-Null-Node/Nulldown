import { getPlatformProxy } from "wrangler";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const option = (name: string) =>
  process.argv
    .find((arg) => arg.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
const input = option("input");
const output = option("output");
if (!input || !output || existsSync(output))
  throw Error(
    "Use --input=command.json --output=fresh-receipt.json; preserve previous receipts.",
  );
const command: unknown = JSON.parse(readFileSync(input, "utf8"));
const platform = await getPlatformProxy<{
  MIGRATION: {
    execute(
      command: unknown,
    ): Promise<{ ok: boolean; error?: { code: string } }>;
  };
}>({
  configPath: resolve(
    "packages/nulldown-state-plane/wrangler.production-control.jsonc",
  ),
  remoteBindings: true,
  persist: false,
});
try {
  const startedAt = new Date().toISOString();
  const result = await platform.env.MIGRATION.execute(command);
  writeFileSync(
    output,
    JSON.stringify(
      { startedAt, completedAt: new Date().toISOString(), command, result },
      null,
      2,
    ),
    { flag: "wx", mode: 0o600 },
  );
  console.log(
    result.ok
      ? `Completed; receipt: ${output}`
      : `Rejected: ${result.error?.code}; receipt: ${output}`,
  );
  if (!result.ok) process.exitCode = 1;
} finally {
  await platform.dispose();
}

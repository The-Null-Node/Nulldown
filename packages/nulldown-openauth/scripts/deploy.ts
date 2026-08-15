const configPath = Bun.env.NULDOWN_OPENAUTH_WRANGLER_CONFIG;

if (!configPath) {
  throw new Error(
    "Deployment is disabled until NULDOWN_OPENAUTH_WRANGLER_CONFIG names a provisioned Worker config. See packages/nulldown-openauth/README.md.",
  );
}

const config = Bun.file(configPath);
if (!(await config.exists())) {
  throw new Error(`OpenAuth Worker config does not exist: ${configPath}`);
}

const source = await config.text();
for (const binding of [
  "OPENAUTH_KV",
  "DB",
  "EMAIL",
  "OPENAUTH_ISSUER_URL",
  "OPENAUTH_EMAIL_FROM",
  "OPENAUTH_CLIENTS_JSON",
]) {
  if (!source.includes(binding)) {
    throw new Error(`OpenAuth Worker config must declare ${binding}.`);
  }
}

const deploy = Bun.spawn(["bunx", "--bun", "wrangler", "deploy", "--config", configPath], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

if ((await deploy.exited) !== 0) {
  throw new Error("OpenAuth Worker deployment failed.");
}

import {
  getArgValue,
  keysFilePath,
  readJsonFile,
  registerCredentialAndUnwrap,
  resolveBaseUrl,
  type DiffClientKeysRecord,
  upsertCredential,
} from "./diffAuthUtil";

const main = async () => {
  const dropId = getArgValue("drop") || getArgValue("id");
  if (!dropId) {
    throw new Error("Missing drop id. Use --drop <dropId>.");
  }

  const keysPath = keysFilePath();
  const keys = await readJsonFile<DiffClientKeysRecord>(keysPath);
  if (!keys) {
    throw new Error(
      `Missing keypair file at ${keysPath}. Run bun run diff:keygen first.`,
    );
  }

  const baseUrl = resolveBaseUrl();
  const credential = await registerCredentialAndUnwrap(baseUrl, dropId, keys);
  await upsertCredential(credential);

  console.log(`Registered diff auth for drop ${credential.dropId}`);
  console.log(`Branch ID: ${credential.branchId}`);
  console.log(`Client ID: ${credential.clientId}`);
  console.log(`KID: ${credential.kid}`);
  console.log(`Expires At: ${credential.expiresAt ?? "none"}`);
};

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to register diff auth: ${message}`);
  process.exit(1);
});

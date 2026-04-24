import { randomUUID } from "node:crypto";
import {
  getArgValue,
  hasArg,
  keysFilePath,
  readJsonFile,
  type DiffClientKeysRecord,
  writeJsonFile,
} from "./diffAuthUtil";

const createClientId = () => {
  const explicit = getArgValue("client");
  if (explicit && explicit.trim()) {
    return explicit.trim();
  }

  return `client_${randomUUID()}`;
};

const generateKeyPair = async (): Promise<DiffClientKeysRecord> => {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  )) as CryptoKeyPair;

  const [encryptionPublicJwk, encryptionPrivateJwk] = await Promise.all([
    crypto.subtle.exportKey("jwk", pair.publicKey),
    crypto.subtle.exportKey("jwk", pair.privateKey),
  ]);

  return {
    version: 1,
    clientId: createClientId(),
    createdAt: Date.now(),
    encryptionPublicJwk,
    encryptionPrivateJwk,
  };
};

const main = async () => {
  const filePath = keysFilePath();
  const existing = await readJsonFile<DiffClientKeysRecord>(filePath);
  const force = hasArg("force");

  if (existing && !force) {
    console.log(`Keys already exist at ${filePath}`);
    console.log("Use --force to replace them.");
    return;
  }

  const generated = await generateKeyPair();
  await writeJsonFile(filePath, generated);

  console.log(`Created diff auth keypair at ${filePath}`);
  console.log(`Client ID: ${generated.clientId}`);
  console.log("Next: bun run diff:register -- --drop <dropId>");
};

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to generate diff auth keys: ${message}`);
  process.exit(1);
});

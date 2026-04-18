import { readFile } from "node:fs/promises";
import {
  DIFF_CLIENT_ID_HEADER,
  DIFF_SECRET_KID_HEADER,
  DIFF_SIGNATURE_HEADER,
  DIFF_TIMESTAMP_HEADER,
} from "../shared/drop/diffAuth";
import {
  credentialsFilePath,
  getArgValue,
  readJsonFile,
  resolveBaseUrl,
  signDiffPayload,
  type DiffCredentialStore,
} from "./diffAuthUtil";

const readBody = async (): Promise<string> => {
  const inline = getArgValue("body");
  if (inline !== null) {
    return inline;
  }

  const bodyFile = getArgValue("body-file");
  if (bodyFile) {
    return readFile(bodyFile, "utf8");
  }

  return "";
};

const main = async () => {
  const dropId = getArgValue("drop") || getArgValue("id");
  if (!dropId) {
    throw new Error("Missing drop id. Use --drop <dropId>.");
  }

  const method = (getArgValue("method") || "POST").toUpperCase();
  const baseUrl = resolveBaseUrl();
  const path = `/api/diff/${encodeURIComponent(dropId)}`;
  const timestamp = String(Date.now());
  const body = await readBody();

  const storePath = credentialsFilePath();
  const store = await readJsonFile<DiffCredentialStore>(storePath);
  const credential = store?.entries?.[dropId];
  if (!credential) {
    throw new Error(
      `No credential for drop ${dropId}. Run bun run diff:register -- --drop ${dropId}`,
    );
  }

  const signature = signDiffPayload(
    credential.secret,
    method,
    path,
    timestamp,
    body,
  );

  console.log("Headers:");
  console.log(`${DIFF_CLIENT_ID_HEADER}: ${credential.clientId}`);
  console.log(`${DIFF_SECRET_KID_HEADER}: ${credential.kid}`);
  console.log(`${DIFF_TIMESTAMP_HEADER}: ${timestamp}`);
  console.log(`${DIFF_SIGNATURE_HEADER}: ${signature}`);

  console.log("\nExample cURL:");
  console.log(`curl -X ${method} \"${baseUrl}${path}\" \\\n+  -H \"Content-Type: application/json\" \\\n+  -H \"${DIFF_CLIENT_ID_HEADER}: ${credential.clientId}\" \\\n+  -H \"${DIFF_SECRET_KID_HEADER}: ${credential.kid}\" \\\n+  -H \"${DIFF_TIMESTAMP_HEADER}: ${timestamp}\" \\\n+  -H \"${DIFF_SIGNATURE_HEADER}: ${signature}\" \\\n+  --data '${body.replace(/'/g, "'\\''")}'`);
};

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to sign diff payload: ${message}`);
  process.exit(1);
});

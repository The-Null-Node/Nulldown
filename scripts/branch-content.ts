import { createBranchApiClient } from "../shared/drop/branchApi";
import { getArgValue, resolveBaseUrl } from "./diffAuthUtil";

const main = async () => {
  const dropId = getArgValue("drop") || getArgValue("id");
  const branchId = getArgValue("branch");
  if (!dropId || !branchId) {
    throw new Error("Missing required args. Use --drop <dropId> --branch <branchId>.");
  }

  const client = createBranchApiClient({
    baseUrl: resolveBaseUrl(),
    accountId: process.env.ND_ACCOUNT_ID || null,
    clientId: getArgValue("client") || null,
  });

  const content = await client.getBranchContent(dropId, branchId);
  console.log(JSON.stringify(content, null, 2));
};

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to read branch content: ${message}`);
  process.exit(1);
});

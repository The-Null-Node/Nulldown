import { createBranchApiClient } from "../shared/drop/branchApi";
import { getArgValue, resolveBaseUrl } from "./diffAuthUtil";

const main = async () => {
  const dropId = getArgValue("drop") || getArgValue("id");
  if (!dropId) {
    throw new Error("Missing drop id. Use --drop <dropId>.");
  }

  const client = createBranchApiClient({
    baseUrl: resolveBaseUrl(),
    accountId: process.env.ND_ACCOUNT_ID || null,
    clientId: getArgValue("client") || null,
  });

  const branch = await client.resolveBranch(dropId);
  console.log(JSON.stringify(branch, null, 2));
};

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to resolve branch: ${message}`);
  process.exit(1);
});

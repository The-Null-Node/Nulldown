import { createBranchApiClient } from "../shared/drop/branchApi";
import { getArgValue, resolveBaseUrl } from "./diffAuthUtil";

const main = async () => {
  const dropId = getArgValue("drop") || getArgValue("id");
  const branchId = getArgValue("branch");
  const expectedSnapshotId = Number(getArgValue("expected-snapshot"));
  const idempotencyKey = getArgValue("idempotency-key");
  if (!dropId || !branchId || !Number.isSafeInteger(expectedSnapshotId) || expectedSnapshotId < 0 || !idempotencyKey) {
    throw new Error(
      "Missing required args. Use --drop <dropId> --branch <branchId> --expected-snapshot <n> --idempotency-key <key>.",
    );
  }

  const client = createBranchApiClient({
    baseUrl: resolveBaseUrl(),
    accountId: process.env.ND_ACCOUNT_ID || null,
    clientId: getArgValue("client") || null,
  });

  const promoted = await client.promoteBranch(dropId, branchId, {
    expectedSnapshotId,
    idempotencyKey,
  });
  console.log(JSON.stringify(promoted, null, 2));
};

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to promote branch: ${message}`);
  process.exit(1);
});

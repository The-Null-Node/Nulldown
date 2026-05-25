import { getArgValue, resolveBaseUrl } from "./diffAuthUtil";

interface BackfillResponse {
  stats: {
    rootDropId: string;
    scanned: number;
    migrated: number;
    alreadyV2: number;
    missing: number;
    failed: number;
  };
  truncated: boolean;
  cursor: string | null;
}

const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

const parseNumberArg = (name: string, fallback: number): number => {
  const raw = getArgValue(name);
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return parsed;
};

const main = async () => {
  const dropId = getArgValue("drop") || getArgValue("id");
  if (!dropId) {
    throw new Error("Missing drop id. Use --drop <dropId>.");
  }

  const token = getArgValue("token") || process.env.BRANCH_HEAP_BACKFILL_TOKEN;
  if (!token) {
    throw new Error(
      "Missing backfill token. Provide --token <token> or BRANCH_HEAP_BACKFILL_TOKEN.",
    );
  }

  const limit = Math.max(1, Math.min(1000, parseNumberArg("limit", 100)));
  const maxBatches = Math.max(1, parseNumberArg("max-batches", 1000));
  const maxRetries = Math.max(0, parseNumberArg("max-retries", 3));
  const retryMs = Math.max(50, parseNumberArg("retry-ms", 500));
  const baseUrl = (getArgValue("base") || resolveBaseUrl()).replace(/\/$/, "");
  let cursor = getArgValue("cursor") || null;

  let batch = 0;
  let totalScanned = 0;
  let totalMigrated = 0;
  let totalAlreadyV2 = 0;
  let totalMissing = 0;
  let totalFailed = 0;

  while (batch < maxBatches) {
    batch += 1;

    const url = new URL(
      `${baseUrl}/api/branches/backfill/${encodeURIComponent(dropId)}`,
    );
    url.searchParams.set("limit", String(limit));
    if (cursor) {
      url.searchParams.set("cursor", cursor);
    }

    let response: Response | null = null;
    let bodyText = "";

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        response = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        bodyText = await response.text();
        if (response.ok) {
          break;
        }

        if (response.status >= 500 && attempt < maxRetries) {
          await sleep(retryMs * (attempt + 1));
          continue;
        }

        throw new Error(
          `Backfill request failed (${response.status}): ${bodyText || "no body"}`,
        );
      } catch (error) {
        if (attempt >= maxRetries) {
          throw error;
        }
        await sleep(retryMs * (attempt + 1));
      }
    }

    if (!response) {
      throw new Error("Backfill request did not produce a response.");
    }

    const parsed = JSON.parse(bodyText) as BackfillResponse;
    totalScanned += parsed.stats.scanned;
    totalMigrated += parsed.stats.migrated;
    totalAlreadyV2 += parsed.stats.alreadyV2;
    totalMissing += parsed.stats.missing;
    totalFailed += parsed.stats.failed;

    const nextCursor = parsed.cursor;
    console.log(
      [
        `batch=${batch}`,
        `cursor=${cursor ?? "start"}`,
        `next=${nextCursor ?? "end"}`,
        `scanned=${parsed.stats.scanned}`,
        `migrated=${parsed.stats.migrated}`,
        `alreadyV2=${parsed.stats.alreadyV2}`,
        `missing=${parsed.stats.missing}`,
        `failed=${parsed.stats.failed}`,
      ].join(" "),
    );

    if (!parsed.truncated || !nextCursor) {
      cursor = null;
      break;
    }

    cursor = nextCursor;
  }

  console.log("---");
  console.log(`drop=${dropId}`);
  console.log(`batches=${batch}`);
  console.log(`scanned=${totalScanned}`);
  console.log(`migrated=${totalMigrated}`);
  console.log(`alreadyV2=${totalAlreadyV2}`);
  console.log(`missing=${totalMissing}`);
  console.log(`failed=${totalFailed}`);
  console.log(`nextCursor=${cursor ?? "none"}`);
  if (cursor) {
    console.log("resume with: --cursor " + cursor);
  }
};

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to backfill branch heap: ${message}`);
  process.exit(1);
});

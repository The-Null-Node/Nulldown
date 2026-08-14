import { createHash } from "node:crypto";
import { jest } from "@jest/globals";
import { promoteBranchSnapshot } from "../functions/api/_lib/branches/services/promotionService";
import { resolveBranchForActor } from "../functions/api/_lib/branches/lifecycle/service";
import { createBranchPromotionReceipt } from "../functions/api/_lib/branches/storage/promotionReceiptRepository";
import { writeBranch } from "../functions/api/_lib/branches/storage/repository";
import { createBranchLockKey } from "../functions/api/_lib/branches/storage/keys";

interface StoredObject {
  value: string;
  etag: string;
  contentType: string;
}

class MemoryR2Bucket {
  private readonly objects = new Map<string, StoredObject>();

  seed(key: string, value: string, contentType = "application/json"): void {
    this.objects.set(key, {
      value,
      contentType,
      etag: this.createEtag(`${key}:${value}:${this.objects.size}`),
    });
  }

  keys(): string[] {
    return Array.from(this.objects.keys());
  }

  async get(key: string): Promise<any> {
    const existing = this.objects.get(key);
    if (!existing) return null;
    return {
      key,
      etag: existing.etag,
      httpEtag: existing.etag,
      httpMetadata: { contentType: existing.contentType },
      text: async () => existing.value,
      json: async <T>() => JSON.parse(existing.value) as T,
    };
  }

  async head(key: string): Promise<any> {
    const existing = this.objects.get(key);
    return existing
      ? {
          key,
          etag: existing.etag,
          httpEtag: existing.etag,
          httpMetadata: { contentType: existing.contentType },
        }
      : null;
  }

  async put(key: string, value: unknown, options?: any): Promise<any> {
    const existing = this.objects.get(key);
    if (options?.onlyIf?.etagDoesNotMatch === "*" && existing) return null;
    if (options?.onlyIf?.etagMatches && existing?.etag !== options.onlyIf.etagMatches) {
      return null;
    }
    const text = typeof value === "string" ? value : String(value ?? "");
    const stored = {
      value: text,
      contentType: options?.httpMetadata?.contentType ?? "application/json",
      etag: this.createEtag(`${key}:${text}:${this.objects.size}`),
    };
    this.objects.set(key, stored);
    return { key, etag: stored.etag, httpEtag: stored.etag };
  }

  async delete(keys: string | string[]): Promise<void> {
    (Array.isArray(keys) ? keys : [keys]).forEach((key) => this.objects.delete(key));
  }

  async list(options?: { prefix?: string }): Promise<any> {
    const prefix = options?.prefix ?? "";
    return {
      objects: this.keys()
        .filter((key) => key.startsWith(prefix))
        .map((key) => ({ key })),
      truncated: false,
    };
  }

  private createEtag(value: string): string {
    return createHash("sha256").update(value).digest("hex");
  }
}

const rootDropId = "root-promotion";
const branchId = "owner";
const accountId = "acct-owner";

const createEnv = (bucket: MemoryR2Bucket) => ({
  R2_BUCKET: bucket,
  PUBLIC_BASE_URL: "https://nulldown.test",
  ALLOW_INSECURE_ACCOUNT_HEADER: "1",
});

const createRequest = (input: {
  expectedSnapshotId: number;
  idempotencyKey: string;
  accountId?: string;
}) =>
  new Request(`https://nulldown.test/api/branches/${rootDropId}/${branchId}/promote`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-nulldown-account-id": input.accountId ?? accountId,
    },
    body: JSON.stringify({
      expectedSnapshotId: input.expectedSnapshotId,
      idempotencyKey: input.idempotencyKey,
    }),
  });

const createSeededBucket = async (): Promise<{
  bucket: MemoryR2Bucket;
  branch: Awaited<ReturnType<typeof resolveBranchForActor>>["branch"];
}> => {
  const bucket = new MemoryR2Bucket();
  bucket.seed(
    rootDropId,
    JSON.stringify({ content: "branch body", metadata: { ownerAccountId: accountId } }),
  );
  const { branch } = await resolveBranchForActor(
    bucket,
    rootDropId,
    accountId,
    "client-1",
  );
  return { bucket, branch };
};

describe("branch promotion contracts", () => {
  let warnSpy: jest.SpiedFunction<typeof console.warn>;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("creates one fenced promotion and replays the completed receipt after the head advances", async () => {
    const { bucket, branch } = await createSeededBucket();
    const env = createEnv(bucket);
    const first = await promoteBranchSnapshot(
      env,
      { rootId: rootDropId, branchId },
      createRequest({ expectedSnapshotId: 0, idempotencyKey: "promotion-1" }),
    );
    expect(first.status).toBe(200);
    const firstPayload = await first.json();
    expect(firstPayload).toEqual(
      expect.objectContaining({ rootDropId, branchId, snapshotId: 0 }),
    );
    const promotedDropId = (firstPayload as { dropId: string }).dropId;
    expect(bucket.keys()).toContain(promotedDropId);

    await writeBranch(bucket, {
      ...branch,
      headSnapshotId: 1,
      updatedAt: branch.updatedAt + 1,
    });
    const replay = await promoteBranchSnapshot(
      env,
      { rootId: rootDropId, branchId },
      createRequest({ expectedSnapshotId: 0, idempotencyKey: "promotion-1" }),
    );

    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toEqual(firstPayload);
    expect(bucket.keys().filter((key) => key === promotedDropId)).toHaveLength(1);
  });

  it("rejects a fresh promotion when the observed branch head is stale", async () => {
    const { bucket, branch } = await createSeededBucket();
    await writeBranch(bucket, {
      ...branch,
      headSnapshotId: 1,
      updatedAt: branch.updatedAt + 1,
    });

    const response = await promoteBranchSnapshot(
      createEnv(bucket),
      { rootId: rootDropId, branchId },
      createRequest({ expectedSnapshotId: 0, idempotencyKey: "promotion-stale" }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        code: "promotion_head_mismatch",
        details: { expectedSnapshotId: 0, actualSnapshotId: 1 },
      }),
    );
  });

  it("recovers a response-lost pending receipt after the branch advances", async () => {
    const { bucket, branch } = await createSeededBucket();
    const receipt = {
      version: 1 as const,
      rootDropId,
      branchId,
      actorAccountId: accountId,
      expectedSnapshotId: 0,
      idempotencyKey: "promotion-response-loss",
      promotedDropId: "promoted001",
      promotedPayload: {
        content: "branch body",
        metadata: { rootDropId, branchId, snapshotId: 0 },
      },
      status: "pending" as const,
      createdAt: 1,
    };
    await createBranchPromotionReceipt(bucket, receipt);
    bucket.seed(receipt.promotedDropId, JSON.stringify(receipt.promotedPayload));
    await writeBranch(bucket, {
      ...branch,
      headSnapshotId: 1,
      updatedAt: branch.updatedAt + 1,
    });

    const response = await promoteBranchSnapshot(
      createEnv(bucket),
      { rootId: rootDropId, branchId },
      createRequest({
        expectedSnapshotId: receipt.expectedSnapshotId,
        idempotencyKey: receipt.idempotencyKey,
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ dropId: receipt.promotedDropId, snapshotId: 0 }),
    );
    expect(bucket.keys().filter((key) => key === receipt.promotedDropId)).toHaveLength(1);
  });

  it("rejects a reused key with a different snapshot and unauthorized actors", async () => {
    const { bucket } = await createSeededBucket();
    const env = createEnv(bucket);
    await promoteBranchSnapshot(
      env,
      { rootId: rootDropId, branchId },
      createRequest({ expectedSnapshotId: 0, idempotencyKey: "promotion-reused" }),
    );

    const mismatched = await promoteBranchSnapshot(
      env,
      { rootId: rootDropId, branchId },
      createRequest({ expectedSnapshotId: 1, idempotencyKey: "promotion-reused" }),
    );
    expect(mismatched.status).toBe(409);
    await expect(mismatched.json()).resolves.toEqual(
      expect.objectContaining({ code: "promotion_idempotency_mismatch" }),
    );

    const forbidden = await promoteBranchSnapshot(
      env,
      { rootId: rootDropId, branchId },
      createRequest({
        expectedSnapshotId: 0,
        idempotencyKey: "promotion-forbidden",
        accountId: "acct-other",
      }),
    );
    expect(forbidden.status).toBe(403);
    await expect(forbidden.json()).resolves.toEqual(
      expect.objectContaining({ code: "promotion_forbidden" }),
    );
  });

  it("returns a retryable response when the branch promotion lock is busy", async () => {
    const { bucket } = await createSeededBucket();
    bucket.seed(
      createBranchLockKey(rootDropId, branchId),
      JSON.stringify({ token: "busy", createdAt: Date.now() }),
    );

    const response = await promoteBranchSnapshot(
      createEnv(bucket),
      { rootId: rootDropId, branchId },
      createRequest({ expectedSnapshotId: 0, idempotencyKey: "promotion-busy" }),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ code: "branch_lock_timeout" }),
    );
  }, 15_000);
});

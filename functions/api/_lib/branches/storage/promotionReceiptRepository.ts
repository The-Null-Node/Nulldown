import type { VoidBlobStore } from "../../../../../src/server/ports";
import { createBranchPromotionReceiptKey } from "./keys";
import { readR2Json, writeR2Json, writeR2JsonIfAbsent } from "./repository";

/** Durable state retained while one snapshot-fenced promotion is being finalized. */
export interface BranchPromotionReceipt {
  version: 1;
  rootDropId: string;
  branchId: string;
  actorAccountId: string;
  expectedSnapshotId: number;
  idempotencyKey: string;
  promotedDropId: string;
  promotedPayload: Record<string, unknown>;
  status: "pending" | "completed";
  createdAt: number;
  completedAt?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonNegativeSafeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Validates a persisted branch promotion receipt before it can be replayed. */
export const isBranchPromotionReceipt = (
  value: unknown,
): value is BranchPromotionReceipt => {
  if (!isRecord(value)) return false;
  return (
    value.version === 1 &&
    typeof value.rootDropId === "string" &&
    typeof value.branchId === "string" &&
    typeof value.actorAccountId === "string" &&
    isNonNegativeSafeInteger(value.expectedSnapshotId) &&
    typeof value.idempotencyKey === "string" &&
    typeof value.promotedDropId === "string" &&
    isRecord(value.promotedPayload) &&
    (value.status === "pending" || value.status === "completed") &&
    Number.isSafeInteger(value.createdAt) &&
    (value.completedAt === undefined || Number.isSafeInteger(value.completedAt))
  );
};

/** Reads one promotion receipt or fails closed when its durable record is malformed. */
export const readBranchPromotionReceipt = async (
  bucket: VoidBlobStore,
  input: Pick<
    BranchPromotionReceipt,
    "rootDropId" | "branchId" | "actorAccountId" | "idempotencyKey"
  >,
): Promise<BranchPromotionReceipt | null> => {
  const key = createBranchPromotionReceiptKey(
    input.rootDropId,
    input.branchId,
    input.actorAccountId,
    input.idempotencyKey,
  );
  const object = await bucket.get(key);
  if (!object) return null;
  const receipt = await readR2Json(bucket, key, isBranchPromotionReceipt);
  if (!receipt) throw new Error("promotion_receipt_integrity_invalid");
  return receipt;
};

/** Creates a receipt once so a response-lost promotion can resume with the same target. */
export const createBranchPromotionReceipt = async (
  bucket: VoidBlobStore,
  receipt: BranchPromotionReceipt,
): Promise<boolean> =>
  writeR2JsonIfAbsent(
    bucket,
    createBranchPromotionReceiptKey(
      receipt.rootDropId,
      receipt.branchId,
      receipt.actorAccountId,
      receipt.idempotencyKey,
    ),
    receipt,
  );

/** Marks a promoted receipt complete only after its target drop is durably present. */
export const completeBranchPromotionReceipt = async (
  bucket: VoidBlobStore,
  receipt: BranchPromotionReceipt,
): Promise<BranchPromotionReceipt> => {
  const completed: BranchPromotionReceipt = {
    ...receipt,
    status: "completed",
    completedAt: Date.now(),
  };
  await writeR2Json(
    bucket,
    createBranchPromotionReceiptKey(
      completed.rootDropId,
      completed.branchId,
      completed.actorAccountId,
      completed.idempotencyKey,
    ),
    completed,
  );
  return completed;
};

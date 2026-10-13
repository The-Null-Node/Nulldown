import { z } from "zod";
import type { BlobObjectStore } from "../../../../../src/server/ports";

const receiptSchema = z.object({
  version: z.literal(1),
  rootDropId: z.string(),
  branchId: z.literal("owner"),
  actorAccountId: z.string(),
  idempotencyKey: z.string(),
  expectedRevision: z.string(),
  expectedSnapshotId: z.number().int().nonnegative(),
  payload: z.string(),
  status: z.enum(["pending", "completed"]),
  revision: z.string().optional(),
  createdAt: z.number(),
});

/** Durable retry record for a same-root publication; payload is the serialized sealed root. */
export type BranchPublicationReceipt = z.infer<typeof receiptSchema>;
type Identity = Pick<
  BranchPublicationReceipt,
  "rootDropId" | "actorAccountId" | "idempotencyKey"
>;
const key = (input: Identity): string =>
  `__drop_publication_receipts__/${encodeURIComponent(input.rootDropId)}/${encodeURIComponent(input.actorAccountId)}/${encodeURIComponent(input.idempotencyKey)}.json`;

/** Reads and validates one persisted publication receipt for a request. */
export const readPublicationReceipt = async (
  blobs: BlobObjectStore,
  identity: Identity,
): Promise<BranchPublicationReceipt | null> => {
  const object = await blobs.get(key(identity));
  if (!object) return null;
  const receipt = receiptSchema.parse(await object.json());
  if (
    receipt.rootDropId !== identity.rootDropId ||
    receipt.actorAccountId !== identity.actorAccountId ||
    receipt.idempotencyKey !== identity.idempotencyKey ||
    (receipt.status === "completed" && !receipt.revision)
  ) {
    throw new Error("publication_receipt_invalid");
  }
  return receipt;
};

/** Persists one receipt while the caller holds the root and owner-branch leases. */
export const writePublicationReceipt = async (
  blobs: BlobObjectStore,
  receipt: BranchPublicationReceipt,
  createOnly = false,
): Promise<void> => {
  const result = await blobs.put(key(receipt), JSON.stringify(receipt), {
    httpMetadata: { contentType: "application/json" },
    ...(createOnly ? { onlyIf: { etagDoesNotMatch: "*" } } : {}),
  });
  if (!result) throw new Error("publication_receipt_write_failed");
};

import type { BranchStatePlacement, BranchStateTarget } from "./branch-state";
import type {
  BranchBatchCommitOutboxRecord,
  BranchCommitOutboxRecord,
} from "./branch-state";
import type { BranchRuntimeFactOutbox } from "./branch-runtime-facts";
import type { BranchNullMemOutbox } from "./branch-nullmem";

/** Canonical durable work records delivered by the state plane. */
export type BranchCanonicalOutbox =
  | BranchCommitOutboxRecord
  | BranchBatchCommitOutboxRecord
  | BranchRuntimeFactOutbox
  | BranchNullMemOutbox;

/** Exact intent plus verified current placement and durable delivery disposition. */
export interface BranchClaimedOutbox {
  target: BranchStateTarget;
  placement: BranchStatePlacement;
  outbox: BranchCanonicalOutbox;
  status: "claimed";
  attempt: number;
  leaseUntil: number;
}

/** A committed canonical intent exposed to an injected delivery adapter. */
export interface BranchOutboxDeliveryItem {
  target: BranchStateTarget;
  placement: BranchStatePlacement;
  outboxId: string;
  leaseToken: string;
}

/** Fenced lease returned by a bounded outbox claim. */
export interface BranchOutboxDeliveryClaim {
  leaseId: string;
  leaseUntil: number;
  items: BranchOutboxDeliveryItem[];
}

/** Claim input; lease identity and time are supplied by the runtime for deterministic tests. */
export interface BranchOutboxClaimCommand {
  leaseId: string;
  now: number;
  leaseMs: number;
  limit: number;
}

/** Exact acknowledgement/retry operation tied to the currently owned lease. */
export interface BranchOutboxClaimResultCommand {
  leaseId: string;
  now: number;
  items: BranchOutboxDeliveryItem[];
}

/** Durable bounded delivery lifecycle, independent of queue/archive providers. */
export interface BranchOutboxDeliveryStatePlane {
  /** Claims due work across the entire local shard; does not perform external I/O. */
  claimOutbox(
    command: BranchOutboxClaimCommand,
  ): Promise<BranchOutboxDeliveryClaim>;
  /** Loads canonical intent only while its reference and lease remain current. */
  readClaimedOutbox(
    command: BranchOutboxClaimResultCommand,
  ): Promise<BranchClaimedOutbox[]>;
  /** Acknowledges only IDs in the live claim; repeated acknowledgements are harmless. */
  acknowledgeOutbox(
    command: BranchOutboxClaimResultCommand,
  ): Promise<{ acknowledged: number; duplicate: number; stale: number }>;
  /** Releases selected live claims with durable retry/backoff state. */
  retryOutbox(
    command: BranchOutboxClaimResultCommand & { errorCode: string },
  ): Promise<{ retried: number; stale: number }>;
  /** Removes only completed delivery bookkeeping, never canonical intent/proof rows. */
  pruneCompletedOutbox(command: {
    before: number;
    limit: number;
  }): Promise<{ pruned: number }>;
}

import {
  BranchStateError,
  BranchStateQuery,
} from "../../../shared/drop/branch-state";
import type {
  BranchOutboxClaimCommand,
  BranchOutboxClaimResultCommand,
} from "../../../shared/drop/branch-outbox-delivery";
import type { BranchCanonicalOutbox } from "../../../shared/drop/branch-outbox-delivery";

/** Upper bound for durable claims; expired work is recovered by the next shard sweep. */
export const MAX_OUTBOX_LEASE_MS = 15 * 60 * 1000;

/** Validates bounded, deterministic inputs shared by persistent delivery adapters. */
export function validateOutboxClaim(command: BranchOutboxClaimCommand): void {
  if (
    !command ||
    typeof command.leaseId !== "string" ||
    command.leaseId.length < 1 ||
    command.leaseId.length > 128 ||
    command.leaseId.trim() !== command.leaseId ||
    !Number.isSafeInteger(command.now) ||
    command.now < 0 ||
    !Number.isSafeInteger(command.leaseMs) ||
    command.leaseMs < 1 ||
    command.leaseMs > MAX_OUTBOX_LEASE_MS ||
    !Number.isSafeInteger(command.limit) ||
    command.limit < 1 ||
    command.limit > 256 ||
    !Number.isSafeInteger(command.now + command.leaseMs)
  )
    throw new BranchStateError("invalid_command");
}

/** Validates exact claim completion input before any persistence mutation. */
export function validateOutboxClaimResult(
  command: BranchOutboxClaimResultCommand,
): void {
  if (
    !command ||
    typeof command.leaseId !== "string" ||
    command.leaseId.length < 1 ||
    command.leaseId.length > 128 ||
    command.leaseId.trim() !== command.leaseId ||
    !Number.isSafeInteger(command.now) ||
    command.now < 0 ||
    !Array.isArray(command.items) ||
    command.items.length > 256 ||
    command.items.some((item) => {
      if (
        !item ||
        typeof item.outboxId !== "string" ||
        !item.outboxId.length ||
        item.outboxId.length > 1024 ||
        typeof item.leaseToken !== "string" ||
        !item.leaseToken.length ||
        item.leaseToken.length > 32768 ||
        !item.target ||
        !item.placement
      )
        return true;
      try {
        BranchStateQuery.head({
          target: item.target,
          placement: item.placement,
        });
        return false;
      } catch {
        return true;
      }
    }) ||
    new Set(command.items.map((item) => item.outboxId)).size !==
      command.items.length
  )
    throw new BranchStateError("invalid_command");
}

/** Lossless opaque token over a JSON tuple; UTF-16 hex avoids separator and surrogate ambiguity. */
export function outboxLeaseToken(
  leaseId: string,
  outboxId: string,
  attempt: number,
): string {
  if (
    typeof leaseId !== "string" ||
    leaseId.length < 1 ||
    leaseId.length > 128 ||
    typeof outboxId !== "string" ||
    outboxId.length < 1 ||
    outboxId.length > 1024 ||
    !Number.isSafeInteger(attempt) ||
    attempt < 1
  )
    throw new BranchStateError("state_corrupt");
  const tuple = JSON.stringify([
    "nulldown.outbox-lease.v1",
    leaseId,
    outboxId,
    attempt,
  ]);
  const token = `v1_${Array.from({ length: tuple.length }, (_, index) => tuple.charCodeAt(index).toString(16).padStart(4, "0")).join("")}`;
  if (token.length > 32768) throw new BranchStateError("state_corrupt");
  return token;
}

/** Bounded exponential retry schedule with deterministic jitter-free semantics. */
export function outboxRetryAt(now: number, attempt: number): number {
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !Number.isSafeInteger(attempt) ||
    attempt < 1
  )
    throw new BranchStateError("invalid_command");
  const delay = Math.min(
    60_000 * 2 ** Math.min(attempt - 1, 10),
    24 * 60 * 60 * 1000,
  );
  const next = now + delay;
  if (!Number.isSafeInteger(next))
    throw new BranchStateError("invalid_command");
  return next;
}

/** Extracts the generation captured by each canonical witness, rejecting ambiguous payloads. */
export function canonicalOutboxPlacement(outbox: BranchCanonicalOutbox) {
  if (!outbox || typeof outbox !== "object" || typeof outbox.id !== "string")
    throw new BranchStateError("state_corrupt");
  const captured =
    outbox.kind === "branch.commit.v1"
      ? outbox.receipt
      : outbox.kind === "branch.batch-commit.v1" ||
          outbox.kind === "branch.runtime-fact.v1"
        ? outbox
        : outbox.kind === "branch.nullmem.v1"
          ? outbox.result?.head
          : undefined;
  try {
    if (!captured) throw new Error("missing outbox placement");
    return BranchStateQuery.head({
      target: captured.target,
      placement: captured.placement,
    });
  } catch {
    throw new BranchStateError("state_corrupt");
  }
}

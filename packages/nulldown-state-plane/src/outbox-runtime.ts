import type {
  BranchClaimedOutbox,
  BranchOutboxClaimResultCommand,
  BranchOutboxDeliveryItem,
} from "../../../shared/drop/branch-outbox-delivery";
import type {
  BranchContentQuery,
  BranchEventRangeQuery,
  BranchHeadQuery,
  BranchStateContent,
} from "../../../shared/drop/branch-state";
import type {
  BranchSnapshotQuery,
  BranchSnapshotState,
} from "../../../shared/drop/branch-lifecycle";
import type { DropDiffEvent } from "../../../shared/drop/diff";
import {
  consumeOutboxBatch,
  materializeClaimedOutbox,
  outboxJobRef,
  StaleOutboxClaimError,
  type OutboxReferenceMessage,
} from "./outbox-platform";
import { D1OutboxProjection, R2OutboxArchive } from "./outbox-storage";
import {
  branchStateShardName,
  BRANCH_STATE_SHARD_COUNT,
  type BranchStateRpcResult,
} from "./shard-router";
import type { BranchStateBindings } from "./branch-state-object";

interface ShardStub {
  claimOutbox(command: {
    leaseId: string;
    now: number;
    leaseMs: number;
    limit: number;
  }): Promise<
    BranchStateRpcResult<{
      leaseId: string;
      leaseUntil: number;
      items: BranchOutboxDeliveryItem[];
    }>
  >;
  readClaimedOutbox(
    command: BranchOutboxClaimResultCommand,
  ): Promise<BranchStateRpcResult<unknown[]>>;
  acknowledgeOutbox(command: BranchOutboxClaimResultCommand): Promise<
    BranchStateRpcResult<{
      acknowledged: number;
      duplicate: number;
      stale: number;
    }>
  >;
  retryOutbox(
    command: BranchOutboxClaimResultCommand & { errorCode: string },
  ): Promise<BranchStateRpcResult<{ retried: number; stale: number }>>;
  pruneCompletedOutbox(command: {
    before: number;
    limit: number;
  }): Promise<BranchStateRpcResult<{ pruned: number }>>;
  readContent(
    query: BranchContentQuery,
  ): Promise<BranchStateRpcResult<unknown>>;
  readSnapshot(
    query: BranchSnapshotQuery,
  ): Promise<BranchStateRpcResult<unknown>>;
  readEvents(
    query: BranchEventRangeQuery,
  ): Promise<BranchStateRpcResult<unknown[]>>;
}

function shard(env: BranchStateBindings, name: string): ShardStub {
  return env.BRANCH_STATE.get(
    env.BRANCH_STATE.idFromName(name),
  ) as unknown as ShardStub;
}
const enabled = (env: BranchStateBindings): boolean =>
  env.STATE_PLANE_OUTBOX_ENABLED === "1" && env.ENVIRONMENT === "staging";
function event(
  eventName: string,
  outcome: string,
  reason: string,
  jobRef?: string,
  shardIndex?: number,
): void {
  try {
    console.log(
      JSON.stringify({
        event: eventName,
        version: 1,
        outcome,
        reason,
        ...(jobRef ? { jobRef } : {}),
        ...(shardIndex === undefined ? {} : { shardIndex }),
      }),
    );
  } catch {
    /* best effort only */
  }
}

/** Claims one bounded page and sends reference-only messages; durable retry state covers send failures. */
export async function dispatchOutboxShard(
  env: BranchStateBindings,
  name: string,
): Promise<void> {
  if (!enabled(env) || !env.OUTBOX_QUEUE) return;
  const stub = shard(env, name);
  const leaseId = crypto.randomUUID();
  const now = Date.now();
  let claim: Awaited<ReturnType<ShardStub["claimOutbox"]>>;
  try {
    claim = await stub.claimOutbox({ leaseId, now, leaseMs: 60_000, limit: 5 });
  } catch {
    event("state_plane.outbox.enqueue", "retry", "claim_unavailable");
    return;
  }
  if (!claim.ok) {
    event("state_plane.outbox.enqueue", "retry", "claim_rejected");
    return;
  }
  for (const item of claim.value.items) {
    const jobRef = await outboxJobRef(item);
    try {
      await env.OUTBOX_QUEUE.send({
        version: 1,
        target: item.target,
        placement: item.placement,
        item,
        leaseId: claim.value.leaseId,
      } satisfies OutboxReferenceMessage);
      event("state_plane.outbox.enqueue", "success", "queued", jobRef);
    } catch {
      try {
        await stub.retryOutbox({
          leaseId,
          now: Date.now(),
          items: [item],
          errorCode: "queue_send_failed",
        });
      } catch {
        /* cron/next request recovers after lease expiry */
      }
      event("state_plane.outbox.enqueue", "retry", "queue_unavailable", jobRef);
    }
  }
}

/** Immediate post-commit wake-up routed to the exact durable shard. */
export async function dispatchOutboxTarget(
  env: BranchStateBindings,
  target: BranchHeadQuery["target"],
  placement: BranchHeadQuery["placement"],
): Promise<void> {
  const name = await branchStateShardName({ target, placement });
  return dispatchOutboxShard(env, name);
}

/** Handles a bounded Queue batch; revalidates exact leases and persists R2+D1 before acknowledgement. */
export async function handleOutboxQueue(
  batch: MessageBatch<OutboxReferenceMessage>,
  env: BranchStateBindings,
): Promise<void> {
  if (
    !enabled(env) ||
    !env.OUTBOX_ARCHIVE ||
    !env.OUTBOX_DB ||
    !env.OUTBOX_ARCHIVE_KEY ||
    !env.OUTBOX_ARCHIVE_KEY_ID
  ) {
    event(
      "state_plane.outbox.consume",
      "retry",
      "consumer_unconfigured",
      undefined,
    );
    for (const message of batch.messages) message.retry({ delaySeconds: 60 });
    return;
  }
  const consumer = {
    async readClaimed(reference: OutboxReferenceMessage) {
      const name = await branchStateShardName({
        target: reference.target,
        placement: reference.placement,
      });
      const stub = shard(env, name);
      const command: BranchOutboxClaimResultCommand = {
        leaseId: reference.leaseId,
        now: Date.now(),
        items: [reference.item],
      };
      const result = await stub.readClaimedOutbox(command);
      if (!result.ok) throw new Error("state_unavailable");
      if (!Array.isArray(result.value) || result.value.length !== 1)
        throw new StaleOutboxClaimError("stale_claim");
      const claimed = result.value[0] as BranchClaimedOutbox;
      return materializeClaimedOutbox(claimed, reference.item, {
        readContent: async (query) => {
          const value = await stub.readContent(query);
          if (!value.ok) throw new Error("state_unavailable");
          return value.value as BranchStateContent;
        },
        readSnapshot: async (query) => {
          const value = await stub.readSnapshot(query);
          if (!value.ok) throw new Error("state_unavailable");
          return value.value as BranchSnapshotState | null;
        },
        readEvents: async (query) => {
          const value = await stub.readEvents(query);
          if (!value.ok) throw new Error("state_unavailable");
          return value.value as DropDiffEvent[];
        },
      });
    },
    async acknowledge(reference: OutboxReferenceMessage) {
      const name = await branchStateShardName({
        target: reference.target,
        placement: reference.placement,
      });
      const result = await shard(env, name).acknowledgeOutbox({
        leaseId: reference.leaseId,
        now: Date.now(),
        items: [reference.item],
      });
      if (!result.ok) throw new Error("state_unavailable");
      return result.value.acknowledged === 1 || result.value.duplicate === 1;
    },
    async retry(reference: OutboxReferenceMessage, reason: string) {
      const name = await branchStateShardName({
        target: reference.target,
        placement: reference.placement,
      });
      const result = await shard(env, name).retryOutbox({
        leaseId: reference.leaseId,
        now: Date.now(),
        items: [reference.item],
        errorCode:
          reason.replace(/[^a-z0-9_.-]/g, "_").slice(0, 80) ||
          "delivery_failed",
      });
      if (!result.ok) throw new Error("state_unavailable");
    },
  };
  await consumeOutboxBatch(batch.messages, {
    enabled: true,
    archiveKey: env.OUTBOX_ARCHIVE_KEY,
    archiveKeyId: env.OUTBOX_ARCHIVE_KEY_ID,
    archive: new R2OutboxArchive(env.OUTBOX_ARCHIVE),
    projection: new D1OutboxProjection(env.OUTBOX_DB),
    consumer,
    emit: ({ name, outcome, reason, jobRef }) =>
      event(name, outcome, reason, jobRef),
  });
}

/** Cron recovery over the frozen 16-shard pool; all claim/retry loops are page-bounded. */
export async function recoverOutbox(env: BranchStateBindings): Promise<void> {
  if (!enabled(env)) return;
  for (let index = 0; index < BRANCH_STATE_SHARD_COUNT; index++) {
    const name = `branch-state-v1-${String(index).padStart(2, "0")}`;
    try {
      await dispatchOutboxShard(env, name);
    } catch {
      event(
        "state_plane.outbox.recovery",
        "retry",
        "shard_unavailable",
        undefined,
        index,
      );
    }
    try {
      const stub = shard(env, name);
      const result = await stub.pruneCompletedOutbox({
        before: Math.max(0, Date.now() - 30 * 24 * 60 * 60 * 1000),
        limit: 100,
      });
      if (!result.ok)
        event(
          "state_plane.outbox.recovery",
          "retry",
          "prune_rejected",
          undefined,
          index,
        );
    } catch {
      event(
        "state_plane.outbox.recovery",
        "retry",
        "prune_unavailable",
        undefined,
        index,
      );
    }
  }
}

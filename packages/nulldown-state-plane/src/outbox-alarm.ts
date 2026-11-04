/** Durable per-shard wake-up metadata; alarms are hints backed by SQLite claims and the cron sweep. */
export interface OutboxWakeState {
  leaseUntil: number;
  retryPolling: boolean;
  retryPolls: number;
  scheduledAt: number | null;
}

/** A minute between durable retry polls. */
export const OUTBOX_RETRY_POLL_MS = 60_000;
/** Maximum one-minute polls, bounding retry-only alarm activity to one day. */
export const OUTBOX_RETRY_POLL_LIMIT = 1_440;
/** Drain delay for a full bounded page while keeping the claim lease recovery armed. */
export const OUTBOX_ALARM_DRAIN_MS = 100;
/** Maximum number of Queue references emitted by one DO alarm. */
export const OUTBOX_ALARM_BATCH_SIZE = 5;
/** Lease duration used by alarm and cron queue producers. */
export const OUTBOX_LEASE_MS = 60_000;

/** Returns a validated default for persisted state after DO eviction or partial storage corruption. */
export function normalizeOutboxWakeState(
  value: OutboxWakeState | undefined,
): OutboxWakeState {
  return value &&
    Number.isSafeInteger(value.leaseUntil) &&
    Number.isSafeInteger(value.retryPolls) &&
    value.retryPolls >= 0 &&
    typeof value.retryPolling === "boolean" &&
    (value.scheduledAt === null ||
      (Number.isSafeInteger(value.scheduledAt) && value.scheduledAt >= 0))
    ? value
    : { leaseUntil: 0, retryPolling: false, retryPolls: 0, scheduledAt: null };
}

/** Merges a mutation/claim/retry wake without postponing an earlier persisted alarm. */
export function scheduleOutboxWake(
  state: OutboxWakeState,
  kind: "new" | "claim" | "retry",
  at: number,
  leaseUntil = 0,
): OutboxWakeState {
  return {
    ...state,
    retryPolling: kind === "retry" || state.retryPolling,
    retryPolls: kind === "retry" ? 0 : state.retryPolls,
    leaseUntil: Math.max(state.leaseUntil, leaseUntil),
    scheduledAt:
      state.scheduledAt === null ? at : Math.min(state.scheduledAt, at),
  };
}

/** Chooses the next bounded wake after an empty page while preserving concurrent writes and lease expiry. */
export function outboxWakeAfterEmpty(
  state: OutboxWakeState,
  now: number,
): OutboxWakeState {
  if (state.scheduledAt !== null && state.scheduledAt > now) return state;
  if (now <= state.leaseUntil)
    return { ...state, scheduledAt: state.leaseUntil + 1 };
  if (state.retryPolling && state.retryPolls < OUTBOX_RETRY_POLL_LIMIT)
    return {
      ...state,
      retryPolls: state.retryPolls + 1,
      scheduledAt: now + OUTBOX_RETRY_POLL_MS,
    };
  return {
    leaseUntil: 0,
    retryPolling: false,
    retryPolls: 0,
    scheduledAt: null,
  };
}

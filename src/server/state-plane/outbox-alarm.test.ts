import { describe, expect, test } from "@jest/globals";
import {
  OUTBOX_RETRY_POLL_LIMIT,
  OUTBOX_RETRY_POLL_MS,
  outboxWakeAfterEmpty,
  scheduleOutboxWake,
  type OutboxWakeState,
} from "../../../packages/nulldown-state-plane/src/outbox-alarm";

const idle: OutboxWakeState = {
  leaseUntil: 0,
  retryPolling: false,
  retryPolls: 0,
  scheduledAt: null,
};

describe("durable outbox alarm scheduling", () => {
  test("merges new commits and claims without postponing an earlier alarm", () => {
    const initial = scheduleOutboxWake(idle, "new", 200);
    expect(scheduleOutboxWake(initial, "claim", 500, 1_000)).toEqual({
      leaseUntil: 1_000,
      retryPolling: false,
      retryPolls: 0,
      scheduledAt: 200,
    });
  });

  test("keeps a lease-expiry recovery wake when the current page is empty", () => {
    const state = { ...idle, leaseUntil: 10_000 };
    expect(outboxWakeAfterEmpty(state, 9_000).scheduledAt).toBe(10_001);
    expect(outboxWakeAfterEmpty(state, 10_001)).toEqual({ ...idle });
  });

  test("polls durable retries without client traffic, bounded by the 24-hour retry ceiling", () => {
    const retrying = scheduleOutboxWake(idle, "retry", 1_000);
    expect(outboxWakeAfterEmpty(retrying, 1_000)).toEqual({
      ...retrying,
      retryPolls: 1,
      scheduledAt: 1_000 + OUTBOX_RETRY_POLL_MS,
    });
    const finalPoll = { ...retrying, retryPolls: OUTBOX_RETRY_POLL_LIMIT - 1 };
    expect(outboxWakeAfterEmpty(finalPoll, 2_000).retryPolls).toBe(
      OUTBOX_RETRY_POLL_LIMIT,
    );
    expect(
      outboxWakeAfterEmpty(
        { ...finalPoll, retryPolls: OUTBOX_RETRY_POLL_LIMIT },
        2_000,
      ),
    ).toEqual(idle);
  });

  test("preserves a concurrent commit wake while an alarm's claim page is in flight", () => {
    const concurrentMutation = scheduleOutboxWake(idle, "new", 5_000);
    expect(outboxWakeAfterEmpty(concurrentMutation, 4_999)).toEqual(
      concurrentMutation,
    );
  });
});

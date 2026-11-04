// Test-only controls for the production Worker, Queue consumer, and DO class.
// This module is bundled only by run-native-outbox-acceptance.ts.
import type { R2Bucket } from "@cloudflare/workers-types";
import type { BranchHeadQuery } from "../../../shared/drop/branch-state";
import type { OutboxReferenceMessage } from "../src/outbox-platform";
import production, { BranchStateObject } from "../src/worker";
import { dispatchOutboxTarget } from "../src/outbox-runtime";
import type { BranchStateBindings } from "../src/branch-state-object";
import { branchStateShardName } from "../src/shard-router";

interface FixtureBindings extends BranchStateBindings {
  OUTBOX_ARCHIVE?: R2Bucket;
  OUTBOX_DB?: D1Database;
}

const lastQueueByRoot = new Map<string, OutboxReferenceMessage>();
let queueMessages = 0;
let referenceOnlyMessages = true;

/** Guarded diagnostic capabilities share the production DO SQLite and SQL code paths. */
export class OutboxAcceptanceObject extends BranchStateObject {
  /** Schedules the real runtime alarm; reserved lifecycle handlers are not RPC methods. */
  async scheduleOutboxAlarmAcceptance() {
    if (this.env.STATE_PLANE_LOCAL_TEST !== "1")
      throw Error("fixture_disabled");
    await this.ctx.storage.setAlarm(Date.now() + 1);
    return { scheduled: true };
  }
  async inspectOutboxAcceptance(query: BranchHeadQuery) {
    if (this.env.STATE_PLANE_LOCAL_TEST !== "1")
      throw Error("fixture_disabled");
    const scope = [
      JSON.stringify(query.target.rootDropId),
      JSON.stringify(query.target.branchId),
    ];
    const delivery = this.ctx.storage.sql
      .exec<{ status: string; n: number }>(
        "SELECT status, COUNT(*) AS n FROM branch_outbox_delivery WHERE root_drop_id=? AND branch_id=? GROUP BY status",
        ...scope,
      )
      .toArray();
    const canonical = this.ctx.storage.sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM (
        SELECT outbox_id FROM branch_outbox WHERE root_drop_id=? AND branch_id=?
        UNION ALL SELECT outbox_id FROM branch_runtime_fact_outbox WHERE root_drop_id=? AND branch_id=?
        UNION ALL SELECT outbox_id FROM branch_nullmem_outbox WHERE root_drop_id=? AND branch_id=?
      )`,
        ...scope,
        ...scope,
        ...scope,
      )
      .one().n;
    return { canonical, delivery };
  }
  async forceOutboxRetryDueFixture(query: BranchHeadQuery) {
    if (this.env.STATE_PLANE_LOCAL_TEST !== "1")
      throw Error("fixture_disabled");
    return this.ctx.storage.sql.exec(
      "UPDATE branch_outbox_delivery SET next_attempt_at=0 WHERE root_drop_id=? AND branch_id=? AND status='pending'",
      JSON.stringify(query.target.rootDropId),
      JSON.stringify(query.target.branchId),
    ).rowsWritten;
  }
}

function projectionFailureBinding(env: FixtureBindings): FixtureBindings {
  const database = env.OUTBOX_DB;
  if (!database) return env;
  const injected = new Proxy(database, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === "batch" && typeof value === "function")
        return async (statements: unknown[]) => {
          const armed = await database
            .prepare("SELECT enabled FROM outbox_acceptance_control WHERE id=1")
            .first<{ enabled: number }>();
          if (armed?.enabled === 1) {
            await database
              .prepare(
                "UPDATE outbox_acceptance_control SET enabled=0 WHERE id=1",
              )
              .run();
            throw Error("FIXTURE_PROJECTION_FAILURE");
          }
          return Reflect.apply(value, target, [statements]);
        };
      if (property !== "prepare" || typeof value !== "function")
        return typeof value === "function" ? value.bind(target) : value;
      return (sql: string) => {
        const shouldFail = sql.includes(
          "INSERT INTO state_plane_outbox_delivery_receipts",
        );
        const wrap = (statement: object): object =>
          new Proxy(statement, {
            get(inner, method) {
              const operation = Reflect.get(inner, method, inner);
              if (
                shouldFail &&
                method === "run" &&
                typeof operation === "function"
              )
                return (...args: unknown[]) => {
                  return (async () => {
                    const armed = await database!
                      .prepare(
                        "SELECT enabled FROM outbox_acceptance_control WHERE id=1",
                      )
                      .first<{ enabled: number }>();
                    if (armed?.enabled === 1) {
                      await database!
                        .prepare(
                          "UPDATE outbox_acceptance_control SET enabled=0 WHERE id=1",
                        )
                        .run();
                      throw Error("FIXTURE_PROJECTION_FAILURE");
                    }
                    return Reflect.apply(operation, inner, args);
                  })();
                };
              if (method === "bind" && typeof operation === "function")
                return (...args: unknown[]) =>
                  wrap(Reflect.apply(operation, inner, args) as object);
              return typeof operation === "function"
                ? operation.bind(inner)
                : operation;
            },
          });
        return wrap(Reflect.apply(value, target, [sql]) as object);
      };
    },
  });
  return new Proxy(env, {
    get(target, property) {
      return property === "OUTBOX_DB"
        ? injected
        : Reflect.get(target, property, target);
    },
  });
}

export default {
  async fetch(request: Request, env: FixtureBindings): Promise<Response> {
    if (env.STATE_PLANE_LOCAL_TEST !== "1")
      return new Response(null, { status: 404 });
    const input = (await request.json()) as {
      action: string;
      query: BranchHeadQuery;
      value?: unknown;
    };
    const name = await branchStateShardName(input.query);
    const stub = env.BRANCH_STATE.get(
      env.BRANCH_STATE.idFromName(name),
    ) as unknown as Record<string, (command: unknown) => Promise<unknown>>;
    try {
      switch (input.action) {
        case "initialize":
          for (const statement of String((input.value as { sql: string }).sql)
            .split(";")
            .map((sql) => sql.trim())
            .filter(Boolean))
            await env.OUTBOX_DB!.prepare(statement).run();
          await env
            .OUTBOX_DB!.prepare(
              "CREATE TABLE IF NOT EXISTS outbox_acceptance_control (id INTEGER PRIMARY KEY, enabled INTEGER NOT NULL)",
            )
            .run();
          await env
            .OUTBOX_DB!.prepare(
              "INSERT OR IGNORE INTO outbox_acceptance_control(id, enabled) VALUES (1, 0)",
            )
            .run();
          return Response.json({ initialized: true });
        case "seed":
          return Response.json(await stub.seedLocalFixtures(input.value));
        case "append":
          return Response.json(await stub.append(input.value));
        case "appendBatch":
          return Response.json(await stub.appendBatch(input.value));
        case "runtimeFact":
          return Response.json(await stub.appendRuntimeFact(input.value));
        case "nullmemPut":
          return Response.json(await stub.putNullMem(input.value));
        case "nullmemDelete":
          return Response.json(await stub.deleteNullMem(input.value));
        case "claim":
          return Response.json(await stub.claimOutbox(input.value));
        case "readClaimed":
          return Response.json(await stub.readClaimedOutbox(input.value));
        case "ack":
          return Response.json(await stub.acknowledgeOutbox(input.value));
        case "retry":
          return Response.json(await stub.retryOutbox(input.value));
        case "prune":
          return Response.json(await stub.pruneCompletedOutbox(input.value));
        case "dispatch":
          await dispatchOutboxTarget(
            env,
            input.query.target,
            input.query.placement,
          );
          return Response.json({ dispatched: true });
        case "recover":
          await production.scheduled!(
            {
              scheduledTime: Date.now(),
              cron: "* * * * *",
              noRetry: () => {},
            } as ScheduledController,
            env,
          );
          return Response.json({ recovered: true });
        case "alarm":
          return Response.json(
            await (
              stub as unknown as OutboxAcceptanceObject
            ).scheduleOutboxAlarmAcceptance(),
          );
        case "duplicateQueue":
          await env.OUTBOX_QUEUE!.send(input.value as OutboxReferenceMessage);
          return Response.json({ queued: true });
        case "duplicateLastQueue":
          {
            const reference = lastQueueByRoot.get(
              input.query.target.rootDropId,
            );
            if (!reference) throw Error("queue_reference_missing");
            await env.OUTBOX_QUEUE!.send(reference);
          }
          return Response.json({ queued: true });
        case "failNextProjection":
          await env
            .OUTBOX_DB!.prepare(
              "UPDATE outbox_acceptance_control SET enabled=1 WHERE id=1",
            )
            .run();
          return Response.json({ armed: true });
        case "inspect": {
          const doStub = stub as unknown as OutboxAcceptanceObject;
          const [state, receipts, cursors, objects] = await Promise.all([
            doStub.inspectOutboxAcceptance(input.query),
            env
              .OUTBOX_DB!.prepare(
                "SELECT COUNT(*) AS n FROM state_plane_outbox_delivery_receipts WHERE root_drop_id=? AND branch_id=?",
              )
              .bind(input.query.target.rootDropId, input.query.target.branchId)
              .first<{ n: number }>(),
            env
              .OUTBOX_DB!.prepare(
                "SELECT domain, generation, version FROM state_plane_outbox_projection_cursor WHERE root_drop_id=? AND branch_id=? ORDER BY domain",
              )
              .bind(input.query.target.rootDropId, input.query.target.branchId)
              .all(),
            env.OUTBOX_ARCHIVE!.list({ limit: 1000 }),
          ]);
          const injection = await env
            .OUTBOX_DB!.prepare(
              "SELECT enabled FROM outbox_acceptance_control WHERE id=1",
            )
            .first<{ enabled: number }>();
          return Response.json({
            state,
            receiptCount: receipts?.n ?? 0,
            cursors: cursors.results,
            archiveCount: objects.objects.length,
            queueMessages,
            referenceOnly: referenceOnlyMessages,
            projectionFailureArmed: injection?.enabled === 1,
          });
        }
        case "makeRetryDue": {
          const result = await stub.forceOutboxRetryDueFixture(input.query);
          return Response.json(result);
        }
        case "claimProbe": {
          const leaseId = `probe-${crypto.randomUUID()}`;
          const now = Date.now();
          const claim = await stub.claimOutbox({
            leaseId,
            now,
            leaseMs: 30_000,
            limit: 5,
          });
          if (!claim.ok)
            return Response.json({ claimed: false, code: claim.error.code });
          const retry = await stub.retryOutbox({
            leaseId,
            now: Date.now(),
            items: claim.value.items,
            errorCode: "acceptance_probe",
          });
          return Response.json({
            claimed: true,
            count: claim.value.items.length,
            retry: retry.ok,
          });
        }
        default:
          return new Response(null, { status: 404 });
      }
    } catch (error) {
      return Response.json(
        {
          fixtureError:
            error instanceof Error ? error.message.slice(0, 120) : "unknown",
        },
        { status: 500 },
      );
    }
  },
  async queue(
    batch: MessageBatch<OutboxReferenceMessage>,
    env: FixtureBindings,
  ): Promise<void> {
    if (env.STATE_PLANE_LOCAL_TEST !== "1") {
      for (const message of batch.messages) message.retry();
      return;
    }
    for (const message of batch.messages) {
      queueMessages++;
      lastQueueByRoot.set(
        message.body.target.rootDropId,
        structuredClone(message.body),
      );
      referenceOnlyMessages &&=
        JSON.stringify(message.body).length < 2_000 &&
        Object.keys(message.body).sort().join(",") ===
          "item,leaseId,placement,target,version" &&
        !JSON.stringify(message.body).includes("artifact") &&
        !JSON.stringify(message.body).includes("content");
    }
    await production.queue!(batch, projectionFailureBinding(env));
  },
  async scheduled(
    controller: ScheduledController,
    env: FixtureBindings,
  ): Promise<void> {
    if (env.STATE_PLANE_LOCAL_TEST !== "1") return;
    await production.scheduled!(controller, env);
  },
};

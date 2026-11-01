// This entrypoint exists only in the maintained local acceptance bundle.
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { onRequest as diffRoute } from "../../../functions/api/diff/[id]";
import { onRequest as contentRoute } from "../../../functions/api/branches/[rootId]/[branchId]/content";
import { onRequest as snapshotsRoute } from "../../../functions/api/branches/[rootId]/[branchId]/snapshots";
import { onRequest as storeRoute } from "../../../functions/api/store";
import { onRequest as resolveRoute } from "../../../functions/api/branches/resolve/[id]";
import { onRequest as getRoute } from "../../../functions/api/get/[id]";
import { onRequest as deleteRoute } from "../../../functions/api/delete/[id]";
import { onRequest as publishRoute } from "../../../functions/api/branches/[rootId]/[branchId]/publish";
import { onRequest as promoteRoute } from "../../../functions/api/branches/[rootId]/[branchId]/promote";
import { onRequest as registerRoute } from "../../../functions/api/diff-auth/register/[id]";
import { onRequest as nullplugStateRoute } from "../../../functions/api/nullplug/state";
import { onRequest as resolvedQueryRoute } from "../../../functions/api/branches/[rootId]/[branchId]/resolved/query";
import type { LocalBranchApplicationSelection } from "../../../src/server/state-plane/commit-application";
import { createLocalBranchLifecycle } from "../../../src/server/state-plane/application-lifecycle";
import type { BranchLifecycleStatePlane } from "../../../shared/drop/branch-lifecycle";
import {
  createCloudflareBlobStore,
  createCloudflareSqlStore,
} from "../../../functions/api/_lib/core/platform/cloudflare/storage";
import { createMemoryRuntimeDataStore } from "../../../src/server/memory-data-store";
import { BranchStateError } from "../../../shared/drop/branch-state";
import {
  decodeBranchStateRpcResult,
  type BranchStateRpcResult,
} from "../src/shard-router";
import {
  applicationFixture,
  applicationLifecycleFixture,
  applicationLifecycleRoots,
  type ApplicationRequestEvidence,
} from "./application-scenarios.fixture";

type Commits = LocalBranchApplicationSelection["commits"];
type RpcBinding = {
  [K in keyof BranchLifecycleStatePlane]: BranchLifecycleStatePlane[K] extends (
    ...args: infer A
  ) => infer R
    ? (...args: A) => Promise<BranchStateRpcResult<Awaited<R>>>
    : never;
};

interface FixtureBindings {
  R2_BUCKET: R2Bucket;
  DB: D1Database;
  BRANCH_STATE_SERVICE: RpcBinding;
  ACCOUNT_AUTH_SECRET: string;
  PROVIDER_ENCRYPTION_PRIVATE_JWK: string;
  FIXTURE_LEGACY_COMPOSITION?: string;
  LEGACY_APPLICATION?: { fetch(request: Request): Promise<Response> };
  FIXTURE_CONTROL: { fetch(request: Request): Promise<Response> };
}

/** Per-request wrapper counts dependency attempts and failures, retaining native receivers. */
function measured<T extends object>(
  target: T,
  label: string,
  evidence: ApplicationRequestEvidence,
  sql?: string,
): T {
  return new Proxy(target, {
    get(object, property) {
      const value = Reflect.get(object, property, object);
      if (typeof value !== "function" || typeof property !== "string")
        return value;
      return (...args: unknown[]) => {
        const key = `${label}.${property}`;
        const row = (evidence.calls[key] ??= { count: 0, errors: 0 });
        row.count++;
        if (
          label === "r2" &&
          ["baseline", "steady-state"].includes(evidence.phase)
        ) {
          row.errors++;
          throw Error("FIXTURE_R2_FORBIDDEN");
        }
        if (
          label === "statement" &&
          ["first", "all", "raw", "run"].includes(property)
        ) {
          if (/^\s*(SELECT|EXPLAIN)\b/i.test(sql ?? "")) evidence.sqlReads++;
          else evidence.sqlWrites++;
        }
        if (label === "d1" && ["exec", "batch"].includes(property))
          evidence.sqlWrites++;
        try {
          const result: unknown = Reflect.apply(value, object, args);
          if (property === "prepare")
            return measured(
              result as object,
              "statement",
              evidence,
              String(args[0]),
            );
          if (property === "bind" || property === "withSession")
            return measured(
              result as object,
              property === "bind" ? "statement" : "d1",
              evidence,
              sql,
            );
          return Promise.resolve(result).catch((error: unknown) => {
            row.errors++;
            throw error;
          });
        } catch (error) {
          row.errors++;
          throw error;
        }
      };
    },
  });
}

export default {
  async fetch(
    request: Parameters<typeof diffRoute>[0]["request"],
    bindings: FixtureBindings,
  ): Promise<Response> {
    const incomingUrl = new URL(request.url);
    if (
      incomingUrl.pathname.startsWith("/__legacy/") &&
      bindings.LEGACY_APPLICATION
    ) {
      const target =
        /^\/__legacy\/api\/(?:branches\/resolve|branches|diff|get|delete)\/([^/]+)/.exec(
          incomingUrl.pathname,
        );
      if (
        !target ||
        decodeURIComponent(target[1]) !== applicationLifecycleFixture.legacyRoot
      )
        return new Response(null, { status: 404 });
      incomingUrl.pathname = incomingUrl.pathname.slice("/__legacy".length);
      return bindings.LEGACY_APPLICATION.fetch(
        new Request(incomingUrl, request),
      );
    }
    const started = performance.now();
    const path = new URL(request.url).pathname;
    const diff = /^\/api\/diff\/([^/]+)$/.exec(path);
    const resolve = /^\/api\/branches\/resolve\/([^/]+)$/.exec(path);
    const get = /^\/api\/get\/([^/]+)$/.exec(path);
    const deletion = /^\/api\/delete\/([^/]+)$/.exec(path);
    const registration = /^\/api\/diff-auth\/register\/([^/]+)$/.exec(path);
    const branch =
      /^\/api\/branches\/([^/]+)\/([^/]+)\/(content|snapshots|publish|promote|resolved\/query)$/.exec(
        path,
      );
    const rootId = decodeURIComponent((diff ?? branch)?.[1] ?? "");
    const evidence: ApplicationRequestEvidence = {
      requestId:
        request.headers.get("x-acceptance-request") ??
        request.headers.get("x-request-id") ??
        crypto.randomUUID(),
      phase:
        bindings.FIXTURE_LEGACY_COMPOSITION === "1"
          ? "legacy"
          : path === "/api/store"
            ? "root-create"
            : get
              ? "root-read"
              : resolve
                ? "bootstrap"
                : rootId === applicationFixture.root ||
                    rootId === applicationFixture.publicRoot
                  ? "baseline"
                  : "steady-state",
      status: 500,
      calls: {},
      rpcFailures: [],
      sqlReads: 0,
      sqlWrites: 0,
      background: { scheduled: 0, completed: 0, failed: 0 },
      observers: [],
      observerFailures: 0,
      handlerMs: 0,
      totalMs: 0,
    };
    const pending: Promise<void>[] = [];
    const waitUntil = (promise: Promise<unknown>) => {
      evidence.background.scheduled++;
      pending.push(
        Promise.resolve(promise).then(
          () => {
            evidence.background.completed++;
          },
          () => {
            evidence.background.failed++;
          },
        ),
      );
    };
    const service = bindings.BRANCH_STATE_SERVICE;
    const fault = async (
      method: string,
      stage: "before" | "after",
      target: { rootDropId: string; branchId: string },
      snapshotId?: number,
    ) => {
      const response = await bindings.FIXTURE_CONTROL.fetch(
        new Request("https://fixture.invalid/rpc", {
          method: "POST",
          body: JSON.stringify({
            method,
            stage,
            target,
            requestId: evidence.requestId,
            snapshotId,
          }),
        }),
      );
      if (!response.ok) throw new BranchStateError("state_unavailable");
      return response.headers.get("x-fixture-stale-generation") === "1";
    };
    const call = async <T>(
      name: string,
      invoke: () => Promise<BranchStateRpcResult<T>>,
    ): Promise<T> => {
      const row = (evidence.calls[`rpc.${name}`] ??= { count: 0, errors: 0 });
      row.count++;
      try {
        return decodeBranchStateRpcResult(await invoke());
      } catch (error) {
        row.errors++;
        evidence.rpcFailures.push({
          method: name,
          code:
            error instanceof BranchStateError
              ? error.code
              : "rpc_transport_failure",
        });
        throw error;
      }
    };
    const commits: Commits = {
      append: (command) => call("append", () => service.append(command)),
      appendBatch: (command) =>
        call("appendBatch", () => service.appendBatch(command)),
      readHead: (query) =>
        call("readHead", async () => {
          const stale =
            applicationLifecycleRoots.includes(query.target.rootDropId) &&
            (await fault("readHead", "before", query.target));
          const result = await service.readHead(
            stale
              ? {
                  ...query,
                  placement: {
                    ...query.placement,
                    generation: query.placement.generation + 1,
                  },
                }
              : query,
          );
          if (
            result.ok &&
            applicationLifecycleRoots.includes(query.target.rootDropId)
          )
            await fault(
              "readHead",
              "after",
              query.target,
              result.value.version.snapshotId,
            );
          return result;
        }),
      readContent: (query) =>
        call("readContent", () => service.readContent(query)),
      readEvents: (query) =>
        call("readEvents", () => service.readEvents(query)),
    };
    const backend: BranchLifecycleStatePlane = {
      ...commits,
      readPlacement: (query) =>
        call("readPlacement", async () => {
          await fault("readPlacement", "before", query.target);
          return service.readPlacement(query);
        }),
      reserve: (command) =>
        call("reserve", async () => {
          const result = await service.reserve(command);
          if (result.ok) await fault("reserve", "after", command.target);
          return result;
        }),
      initialize: (command) =>
        call("initialize", async () => {
          const result = await service.initialize(command);
          if (result.ok) await fault("initialize", "after", command.target);
          return result;
        }),
      readSnapshot: (query) =>
        call("readSnapshot", () => service.readSnapshot(query)),
      listSnapshots: (query) =>
        call("listSnapshots", () => service.listSnapshots(query)),
    };
    const observer = (
      id: string,
    ): NonNullable<
      LocalBranchApplicationSelection["snapshotters"]
    >[number] => ({
      id,
      async snapshot(context) {
        const bytes = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(context.frame.content),
        );
        evidence.observers.push({
          id,
          snapshotId: context.snapshotId,
          parentSnapshotId: context.parentSnapshotId,
          eventIds: context.acceptedEvents.map((event) => event.eventId),
          sequences: context.acceptedEvents.map((event) => event.seq),
          textLength: context.frame.content.length,
          contentHash: Array.from(new Uint8Array(bytes), (byte) =>
            byte.toString(16).padStart(2, "0"),
          ).join(""),
        });
      },
    });
    const bucket = measured(bindings.R2_BUCKET, "r2", evidence);
    const db = measured(bindings.DB, "d1", evidence);
    const sql = createCloudflareSqlStore(db);
    if (!sql) throw Error("FIXTURE_SQL_REQUIRED");
    const baseline = evidence.phase === "baseline";
    const selection: LocalBranchApplicationSelection = {
      mode: "local-test",
      commits,
      placement: { ...applicationFixture.placement },
      ...(!baseline
        ? {
            lifecycle: createLocalBranchLifecycle({
              mode: "local-test",
              blobs: createCloudflareBlobStore(bucket),
              sql,
              providerPrivateKey: bindings.PROVIDER_ENCRYPTION_PRIVATE_JWK,
              backend,
              isEligibleRoot: (id) => applicationLifecycleRoots.includes(id),
              initialPlacement: { ...applicationFixture.placement },
            }),
            history: backend,
          }
        : {}),
      data: measured(createMemoryRuntimeDataStore(), "data", evidence),
      snapshotters: [
        observer("fixture.before"),
        {
          id: "fixture.throwing",
          snapshot() {
            evidence.observerFailures++;
            throw Error("SYNTHETIC_OBSERVER_FAILURE");
          },
        },
        observer("fixture.after"),
      ],
    };
    const env = {
      ...bindings,
      R2_BUCKET: bucket,
      DB: db,
      ALLOW_INSECURE_ACCOUNT_HEADER: "0",
      LOG_LEVEL: "silent",
      PUBLIC_BASE_URL: new URL(request.url).origin,
      ASSETS: {
        fetch: async (): Promise<never> => {
          throw Error("FIXTURE_ASSETS_UNSUPPORTED");
        },
      },
      localBranchApplication:
        bindings.FIXTURE_LEGACY_COMPOSITION === "1" ? undefined : selection,
    };
    const pagesContext = {
      request,
      env,
      waitUntil,
      functionPath: path,
      data: {},
      next: async (): Promise<never> => {
        throw Error("FIXTURE_NEXT_UNSUPPORTED");
      },
      passThroughOnException: (): never => {
        throw Error("FIXTURE_PASSTHROUGH_UNSUPPORTED");
      },
    };
    let response: Response;
    // The fixture only adapts Workers fetch to the existing Pages handler context.
    // Authentication, public schema validation, route dispatch and errors stay in application code.
    if (path === "/api/store") {
      response = await storeRoute({ ...pagesContext, params: {} });
    } else if (path === "/api/nullplug/state") {
      response = await nullplugStateRoute({ ...pagesContext, params: {} });
    } else if (resolve || get || deletion || registration) {
      const match = (resolve ?? get ?? deletion ?? registration)!;
      const handler = resolve
        ? resolveRoute
        : get
          ? getRoute
          : deletion
            ? deleteRoute
            : registerRoute;
      response = await handler({
        ...pagesContext,
        params: { id: decodeURIComponent(match[1]) },
      });
    } else if (diff) {
      response = await diffRoute({
        ...pagesContext,
        params: { id: decodeURIComponent(diff[1]) },
      });
    } else if (branch) {
      const handler =
        branch[3] === "content"
          ? contentRoute
          : branch[3] === "snapshots"
            ? snapshotsRoute
            : branch[3] === "publish"
              ? publishRoute
              : branch[3] === "promote"
                ? promoteRoute
                : resolvedQueryRoute;
      response = await handler({
        ...pagesContext,
        params: {
          rootId: decodeURIComponent(branch[1]),
          branchId: decodeURIComponent(branch[2]),
        },
      });
    } else response = new Response(null, { status: 404 });
    evidence.handlerMs = performance.now() - started;
    // Drain work scheduled by work itself as well as initial waitUntil tasks.
    for (let cursor = 0; cursor < pending.length; cursor++)
      await pending[cursor];
    evidence.status = response.status;
    evidence.totalMs = performance.now() - started;
    const headers = new Headers(response.headers);
    const report = JSON.stringify(evidence);
    if (report.length > 12000) throw Error("FIXTURE_EVIDENCE_BOUND_EXCEEDED");
    headers.set("x-state-plane-evidence", report);
    return new Response(response.body, { status: response.status, headers });
  },
};

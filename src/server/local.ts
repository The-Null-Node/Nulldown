import { join } from "node:path";
import { isDropIdToken, toShortDropId } from "../../shared/drop/id";
import { createRequestLogger, toLogRef } from "../../functions/api/_lib/core/logging/logger";
import { getBranchContent, listBranchesForDrop, listBranchSnapshots, resolveBranchForRequest } from "../../functions/api/_lib/branches/services/routeService";
import { createNullMemFact, createNullMemProcedure, createNullMemService, queryNullMem } from "../../functions/api/_lib/nullmem/service";
import { createResolvedPriorityFact, deleteResolvedPriorityFact, listResolvedPriorityFacts, queryResolvedHeap, updateResolvedHeap } from "../../functions/api/_lib/resolved/heap/service";
import { pollDiffEvents, postDiffEvents } from "../../functions/api/_lib/diffs/transport/service";
import { resolveRemoteDropId, removeRemoteAliasIfMatch } from "../../functions/api/_lib/drops/identity/id";
import { REMOTE_PUBLIC_DROP_INDEX_PREFIX, readPublicDropIndexEntryByKey, removePublicDropIndexEntry } from "../../functions/api/_lib/drops/index/repository";
import { storeDrop, type StoreServiceEnv } from "../../functions/api/_lib/drops/services/storeDrop";
import { appendEventsToBranch } from "../../functions/api/_lib/nulledit/service";
import { createBuiltInNulleditSnapshotters } from "./nulledit";
import { createVoidProvider } from "./provider";
import { createMemoryVoidDataStore } from "./memoryDataStore";
import { createFilesystemBlobStore } from "./filesystemBlobStore";
import { createNulldownServer, type NulldownServer, type NulldownServerRoute } from "./http";
import type { VoidBlobStore, VoidDataStore, VoidSqlStore } from "./ports";

/** Environment variables and ports used by the local Nulldown server adapter. */
export interface LocalNulldownServerEnv extends Omit<StoreServiceEnv, "blobs" | "sql"> {
  /** Blob storage used by existing backend services through the R2-shaped keyspace. */
  R2_BUCKET: VoidBlobStore;
  /** Optional SQL metadata store. `nd serve` supplies a Bun SQLite implementation by default. */
  DB?: VoidSqlStore;
  /** Allows local branch ownership via account headers when auth secrets are absent. */
  ALLOW_INSECURE_ACCOUNT_HEADER?: string;
  /** Optional shared secret for diff transport authentication. */
  DIFF_WEBHOOK_SECRET?: string;
  /** Optional maximum diff auth timestamp skew in milliseconds. */
  DIFF_AUTH_MAX_SKEW_MS?: string;
  /** Optional token for metadata maintenance routes. */
  METADATA_BACKFILL_TOKEN?: string;
  /** Optional token for public-index maintenance routes. */
  DROP_INDEX_BACKFILL_TOKEN?: string;
  /** Log threshold used by request loggers. */
  LOG_LEVEL?: string;
}

/** Options for creating a local filesystem-backed Nulldown server. */
export interface CreateLocalNulldownServerOptions {
  /** Directory for local data. Blob objects are stored under `<dataDir>/blobs`. */
  dataDir: string;
  /** Public base URL used in store responses. */
  publicBaseUrl?: string;
  /** Optional SQL metadata store for future SQLite adapters. */
  sql?: VoidSqlStore;
  /** Optional functional data store. Defaults to an in-memory store. */
  data?: VoidDataStore;
  /** Optional log level passed to backend request loggers. */
  logLevel?: string;
}

const json = (value: unknown, init?: ResponseInit): Response =>
  new Response(JSON.stringify(value), {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });

const routeParams = (params: Record<string, string>) => params;

const createStoreEnv = (env: LocalNulldownServerEnv): StoreServiceEnv => ({
  ...env,
  blobs: env.R2_BUCKET,
  sql: env.DB,
});

const listPublicDrops = async (
  env: LocalNulldownServerEnv,
  request: Request,
): Promise<Response> => {
  const url = new URL(request.url);
  const limitParam = Number.parseInt(url.searchParams.get("limit") || "", 10);
  const limit = Number.isFinite(limitParam) ? Math.max(1, Math.min(1000, limitParam)) : 200;
  const cursor = url.searchParams.get("cursor") || undefined;
  const listed = await env.R2_BUCKET.list({
    prefix: REMOTE_PUBLIC_DROP_INDEX_PREFIX,
    limit,
    cursor,
  });
  const entries = await Promise.all(
    listed.objects.map((entry) => readPublicDropIndexEntryByKey(env.R2_BUCKET, entry.key)),
  );
  const items = entries
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    .map((entry) => ({ id: entry.id, createdAt: entry.createdAt, updatedAt: entry.updatedAt }))
    .sort((left, right) => right.updatedAt - left.updatedAt);
  return json({ items, cursor: listed.truncated ? listed.cursor : null });
};

const getDrop = async (
  env: LocalNulldownServerEnv,
  request: Request,
  requestedId: string,
): Promise<Response> => {
  const logger = createRequestLogger({ request, env, route: "/api/get/:id", successSampleRate: 0.1 });
  logger.logStart({ requestedDropRef: toLogRef(requestedId) });
  const id = await resolveRemoteDropId(env.R2_BUCKET, requestedId, logger, env.DB);
  if (!id) return new Response("Drop ID is required.", { status: 400 });
  const object = await env.R2_BUCKET.get(id);
  if (!object) return new Response("Drop not found.", { status: 404 });
  const headers = new Headers({
    "Content-Type": object.httpMetadata?.contentType || "text/plain",
    "X-Drop-Canonical-Id": id,
  });
  if (object.httpEtag) {
    headers.set("ETag", object.httpEtag);
    headers.set("X-Drop-Revision", object.httpEtag);
  }
  logger.logEnd(200, { canonicalDropRef: toLogRef(id) });
  return new Response(object.body ?? await object.text(), { status: 200, headers });
};

const deleteDrop = async (
  env: LocalNulldownServerEnv,
  request: Request,
  requestedId: string,
): Promise<Response> => {
  const logger = createRequestLogger({ request, env, route: "/api/delete/:id" });
  logger.logStart({ requestedDropRef: toLogRef(requestedId) });
  const id = await resolveRemoteDropId(env.R2_BUCKET, requestedId, logger, env.DB);
  if (!id || !isDropIdToken(id)) return json({ error: "Drop ID is required.", code: "invalid_drop_id" }, { status: 400 });

  const expectedRevision = request.headers.get("If-Match")?.trim();
  if (expectedRevision) {
    const object = await env.R2_BUCKET.get(id);
    if (!object) return json({ error: "Drop not found.", code: "drop_not_found" }, { status: 404 });
    if (object.httpEtag !== expectedRevision) {
      return json({ error: "Drop revision precondition failed.", code: "revision_precondition_failed" }, { status: 412 });
    }
  }

  await Promise.all([
    env.R2_BUCKET.delete(id),
    removeRemoteAliasIfMatch(env.R2_BUCKET, id, logger, env.DB),
    removePublicDropIndexEntry(env.R2_BUCKET, id, env.DB),
  ]);
  logger.logEnd(204, { canonicalDropRef: toLogRef(id) });
  return new Response(null, { status: 204 });
};

/** Creates a local Nulldown Web server backed by filesystem blobs. */
export const createLocalNulldownServer = ({
  dataDir,
  publicBaseUrl,
  sql,
  data = createMemoryVoidDataStore(),
  logLevel,
}: CreateLocalNulldownServerOptions): NulldownServer => {
  const blobs = createFilesystemBlobStore({ rootDir: join(dataDir, "blobs") });
  const builtInSnapshotters = createBuiltInNulleditSnapshotters();
  const env: LocalNulldownServerEnv = {
    R2_BUCKET: blobs,
    DB: sql,
    PUBLIC_BASE_URL: publicBaseUrl,
    ALLOW_INSECURE_ACCOUNT_HEADER: "1",
    LOG_LEVEL: logLevel,
  };
  const voidProvider = createVoidProvider({
    data,
    nulledit: {
      appendDiffEvents: ({ branch, events, ...options }) =>
        appendEventsToBranch(
          blobs,
          branch,
          events,
          {
            ...options,
            data,
            snapshotters: [...builtInSnapshotters, ...(options.snapshotters ?? [])],
          },
          sql,
        ),
    },
    memory: createNullMemService({ blobs, sql }),
  });

  const routes: NulldownServerRoute[] = [
    {
      method: "POST",
      path: "/api/store",
      handler: ({ request }) => {
        const logger = createRequestLogger({ request, env, route: "/api/store" });
        logger.logStart();
        return storeDrop({ request, env: createStoreEnv(env), logger });
      },
    },
    { method: "GET", path: "/api/get/:id", handler: ({ request, params }) => getDrop(env, request, params.id) },
    { method: "GET", path: "/api/list", handler: ({ request }) => listPublicDrops(env, request) },
    { method: "DELETE", path: "/api/delete/:id", handler: ({ request, params }) => deleteDrop(env, request, params.id) },
    { method: "GET", path: "/api/diff/:id", handler: ({ request, params }) => pollDiffEvents(env, routeParams(params), request) },
    { method: "POST", path: "/api/diff/:id", handler: ({ request, params }) => postDiffEvents(env, routeParams(params), request, { voidProvider }) },
    { method: "GET", path: "/api/branches/:id", handler: ({ params }) => listBranchesForDrop(env, routeParams(params)) },
    { method: "POST", path: "/api/branches/resolve/:id", handler: ({ request, params }) => resolveBranchForRequest(env, routeParams(params), request) },
    { method: "GET", path: "/api/branches/:rootId/:branchId/content", handler: ({ params }) => getBranchContent(env, routeParams(params)) },
    { method: "GET", path: "/api/branches/:rootId/:branchId/snapshots", handler: ({ params }) => listBranchSnapshots(env, routeParams(params)) },
    { method: "GET", path: "/api/branches/:rootId/:branchId/resolved/query", handler: ({ request, params }) => queryResolvedHeap(env, routeParams(params), request) },
    { method: "POST", path: "/api/branches/:rootId/:branchId/resolved/update", handler: ({ request, params }) => updateResolvedHeap(env, routeParams(params), request) },
    { method: "GET", path: "/api/branches/:rootId/:branchId/resolved/priority", handler: ({ request, params }) => listResolvedPriorityFacts(env, routeParams(params), request) },
    { method: "POST", path: "/api/branches/:rootId/:branchId/resolved/priority", handler: ({ request, params }) => createResolvedPriorityFact(env, routeParams(params), request) },
    { method: "DELETE", path: "/api/branches/:rootId/:branchId/resolved/priority/:factId", handler: ({ request, params }) => deleteResolvedPriorityFact(env, routeParams(params), request) },
    { method: "GET", path: "/api/branches/:rootId/:branchId/memory/query", handler: ({ request, params }) => queryNullMem(env, routeParams(params), request, { memory: voidProvider.memory }) },
    { method: "POST", path: "/api/branches/:rootId/:branchId/memory/facts", handler: ({ request, params }) => createNullMemFact(env, routeParams(params), request, { memory: voidProvider.memory }) },
    { method: "POST", path: "/api/branches/:rootId/:branchId/memory/procedures", handler: ({ request, params }) => createNullMemProcedure(env, routeParams(params), request, { memory: voidProvider.memory }) },
  ];

  return createNulldownServer({ routes });
};

/** Returns the default public URL for a local Nulldown server. */
export const localNulldownServerBaseUrl = (host: string, port: number): string =>
  `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;

/** Returns the short app link path for a stored drop id under a local server. */
export const localDropPath = (dropId: string): string => `/d/${toShortDropId(dropId)}`;

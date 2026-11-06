/// <reference path="../staging-api-configuration.d.ts" />
import type {
  ExecutionContext,
  ExportedHandler,
  IncomingRequestCfProperties,
  PagesFunction,
} from "@cloudflare/workers-types";
import { onRequest as apiMiddleware } from "../../../functions/api/_middleware";
import { onRequest as sessionRoute } from "../../../functions/api/auth/session";
import { onRequest as storeRoute } from "../../../functions/api/store";
import { onRequest as getRoute } from "../../../functions/api/get/[id]";
import { onRequest as diffRoute } from "../../../functions/api/diff/[id]";
import { onRequest as resolveRoute } from "../../../functions/api/branches/resolve/[id]";
import { onRequest as contentRoute } from "../../../functions/api/branches/[rootId]/[branchId]/content";
import { onRequest as snapshotsRoute } from "../../../functions/api/branches/[rootId]/[branchId]/snapshots";
import { onRequest as memoryQueryRoute } from "../../../functions/api/branches/[rootId]/[branchId]/memory/query";
import { onRequest as memoryFactRoute } from "../../../functions/api/branches/[rootId]/[branchId]/memory/facts";
import { onRequest as memoryProcedureRoute } from "../../../functions/api/branches/[rootId]/[branchId]/memory/procedures";
import { onRequest as memoryDeleteRoute } from "../../../functions/api/branches/[rootId]/[branchId]/memory/[recordId]";
import { onRequest as nullplugStateRoute } from "../../../functions/api/nullplug/state";
import { onRequest as nullplugSubmitRoute } from "../../../functions/api/nullplug/submit";
import { onRequest as deleteRoute } from "../../../functions/api/delete/[id]";
import { onRequest as registerRoute } from "../../../functions/api/diff-auth/register/[id]";
import { onRequest as publishRoute } from "../../../functions/api/branches/[rootId]/[branchId]/publish";
import { onRequest as promoteRoute } from "../../../functions/api/branches/[rootId]/[branchId]/promote";
import { onRequest as resolvedQueryRoute } from "../../../functions/api/branches/[rootId]/[branchId]/resolved/query";
import { readTelemetryBatch } from "../../../functions/api/_lib/core/observability/transport";
import { BRANCH_STATE_ERRORS } from "../../../shared/drop/branch-state";
import {
  createStagingBranchApplication,
  type StagingSelectionDependencies,
} from "./staging-selection";
import type { BranchStateRpcStub } from "./shard-router";
import {
  BranchStateQuery,
  type BranchStateTarget,
} from "../../../shared/drop/branch-state";
import {
  createLegacySourceWriter,
  type SourceMutationKind,
  type SourceWriterAdmission,
} from "../../../src/server/state-plane/legacy-source-writer";

/** Request-bound dependencies of the isolated API gateway; deployment wiring supplies these ports. */
export interface StagingApplicationDependencies extends StagingSelectionDependencies {
  ACCOUNT_AUTH_SECRET: string;
  ACCOUNT_AUTH_TOKEN_TTL_MS?: string;
  PROVIDER_SIGNING_PRIVATE_JWK: string;
  PUBLIC_BASE_URL?: string;
  LOG_LEVEL?: string;
}

/** Trusted, request-independent source-fence authority for isolated legacy staging. */
export interface FencedLegacyStagingAuthority {
  target: BranchStateTarget;
  generation: number;
  admission: SourceWriterAdmission;
}

/** Dependencies for a legacy-source staging request; authority is injected by trusted deployment wiring. */
export interface FencedLegacyStagingDependencies extends Omit<
  StagingApplicationDependencies,
  "STATE_PLANE"
> {
  LEGACY_SOURCE_AUTHORITY: FencedLegacyStagingAuthority;
}

type StagingGatewayDependencies = Omit<
  StagingApplicationDependencies,
  "STATE_PLANE"
> & { STATE_PLANE: unknown };

type ApplicationEnvironment = Omit<
  StagingApplicationDependencies,
  "STATE_PLANE"
> & {
  localBranchApplication?: ReturnType<typeof createStagingBranchApplication>;
  legacySourceWriter?: ReturnType<typeof createLegacySourceWriter>;
  ALLOW_INSECURE_ACCOUNT_HEADER: "0";
  PUBLIC_BASE_URL: string;
  ASSETS: { fetch: typeof fetch };
};
type RouteParams = "id" | "rootId" | "branchId" | "recordId";
type Route = {
  pattern: RegExp;
  params: RouteParams[];
  handler: PagesFunction<ApplicationEnvironment, RouteParams>;
};

// Reuse actual Pages adapters, including their methods, authorization and errors.
// Unsupported operations remain reachable to exercise their selected-authority guards.
const routes: Route[] = [
  { pattern: /^\/api\/auth\/session$/, params: [], handler: sessionRoute },
  { pattern: /^\/api\/store$/, params: [], handler: storeRoute },
  { pattern: /^\/api\/get\/([^/]+)$/, params: ["id"], handler: getRoute },
  { pattern: /^\/api\/diff\/([^/]+)$/, params: ["id"], handler: diffRoute },
  {
    pattern: /^\/api\/branches\/resolve\/([^/]+)$/,
    params: ["id"],
    handler: resolveRoute,
  },
  {
    pattern: /^\/api\/nullplug\/state$/,
    params: [],
    handler: nullplugStateRoute,
  },
  {
    pattern: /^\/api\/nullplug\/submit$/,
    params: [],
    handler: nullplugSubmitRoute,
  },
  { pattern: /^\/api\/delete\/([^/]+)$/, params: ["id"], handler: deleteRoute },
  {
    pattern: /^\/api\/diff-auth\/register\/([^/]+)$/,
    params: ["id"],
    handler: registerRoute,
  },
  ...(
    [
      ["content", contentRoute],
      ["snapshots", snapshotsRoute],
      ["publish", publishRoute],
      ["promote", promoteRoute],
      ["resolved/query", resolvedQueryRoute],
      ["memory/query", memoryQueryRoute],
      ["memory/facts", memoryFactRoute],
      ["memory/procedures", memoryProcedureRoute],
    ] satisfies Array<[string, Route["handler"]]>
  ).map(([suffix, handler]) => ({
    pattern: new RegExp(`^/api/branches/([^/]+)/([^/]+)/${suffix}$`),
    params: ["rootId", "branchId"] as RouteParams[],
    handler,
  })),
  {
    pattern: /^\/api\/branches\/([^/]+)\/([^/]+)\/memory\/([^/]+)$/,
    params: ["rootId", "branchId", "recordId"],
    handler: memoryDeleteRoute,
  },
];

const failure = (status: number, code: string): Response =>
  Response.json(
    { error: code, code },
    {
      status,
      headers: { "x-diagnostic-reason": code, "Cache-Control": "no-store" },
    },
  );

const reasonForResponse = (path: string, status: number): string => {
  if (status < 400) return "completed";
  if (status === 501) return "capability_unsupported";
  if (path === "/api/auth/session" && status === 401)
    return "account_proof_rejected";
  if (status === 401) return "account_auth_required";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 405) return "method_not_allowed";
  if (status === 409) return "conflict";
  if (status >= 500) return "state_unavailable";
  return "invalid_request";
};

const diagnosticReasons = new Set([
  ...Object.keys(BRANCH_STATE_ERRORS),
  "account_proof_rejected",
  "account_auth_required",
  "account_required",
  "branch_authority_mismatch",
  "branch_initialization_root_identity_mismatch",
  "conflict",
  "dependency_unavailable",
  "forbidden",
  "invalid_request",
  "invalid_route_parameter",
  "method_not_allowed",
  "not_found",
  "principal_verification_rejected",
  "session_missing",
  "staging_configuration_unavailable",
  "state_unavailable",
]);

const responseReason = (path: string, response: Response): string => {
  const diagnostic = response.headers.get("x-diagnostic-reason");
  return diagnostic && diagnosticReasons.has(diagnostic)
    ? diagnostic
    : reasonForResponse(path, response.status);
};

const isBranchStateRpcStub = (value: unknown): value is BranchStateRpcStub => {
  if (typeof value !== "object" || value === null) return false;
  const required = ["append", "readHead", "readContent", "readEvents"];
  const optional = [
    "queryNullMem",
    "putNullMem",
    "deleteNullMem",
    "appendRuntimeFact",
    "readRuntimeFactHead",
    "readRuntimeFacts",
    "readPlacement",
    "reserve",
    "initialize",
    "readSnapshot",
    "listSnapshots",
    "appendBatch",
  ];
  return (
    required.every(
      (method) => typeof Reflect.get(value, method) === "function",
    ) &&
    optional.every((method) => {
      const member = Reflect.get(value, method);
      return member === undefined || typeof member === "function";
    })
  );
};

// Same bounded event codec and delivery failure isolation as the API middleware,
// retained directly in this deployment's Workers Logs without an external binding.
const requestSummaryLog = (reason: () => string) => ({
  async fetch(request: Request): Promise<Response> {
    for (const event of (await readTelemetryBatch(request)) ?? [])
      console.info(
        JSON.stringify({ ...event, environment: "staging", reason: reason() }),
      );
    return new Response(null, { status: 204 });
  },
});

/**
 * Runs existing Pages handlers with a fresh selection and real platform request lifetime.
 * The gateway has no fixture controls or public RPC forwarding. Authentication remains
 * inside the normal application handlers; client account headers cannot select identity.
 */
export async function fetchStagingApplication(
  request: Request<unknown, IncomingRequestCfProperties>,
  bindings: StagingGatewayDependencies,
  execution: Pick<ExecutionContext, "waitUntil">,
): Promise<Response> {
  return fetchApplication(request, bindings, execution, {
    mode: "state-plane",
  });
}

/**
 * Runs the same authenticated Pages adapters against the trusted, fenced legacy source.
 * The source gate must already be registered for this exact target/generation. Missing
 * or malformed authority fails closed; request data never selects writer scope.
 */
export async function fetchFencedLegacyStagingApplication(
  request: Request<unknown, IncomingRequestCfProperties>,
  bindings: FencedLegacyStagingDependencies,
  execution: Pick<ExecutionContext, "waitUntil">,
): Promise<Response> {
  return fetchApplication(request, bindings, execution, {
    mode: "fenced-legacy",
    authority: bindings.LEGACY_SOURCE_AUTHORITY,
  });
}

async function fetchApplication(
  request: Request<unknown, IncomingRequestCfProperties>,
  bindings: Omit<StagingGatewayDependencies, "STATE_PLANE"> & {
    STATE_PLANE?: unknown;
  },
  execution: Pick<ExecutionContext, "waitUntil">,
  selection:
    | { mode: "state-plane" }
    | { mode: "fenced-legacy"; authority: FencedLegacyStagingAuthority },
): Promise<Response> {
  const path = new URL(request.url).pathname;
  let summaryReason = "state_unavailable";
  const rejected = (status: number, code: string): Response => {
    summaryReason = code;
    return failure(status, code);
  };
  const base = {
    request,
    functionPath: path,
    data: {},
    params: { id: "", rootId: "", branchId: "", recordId: "" },
    waitUntil: (promise: Promise<unknown>) => execution.waitUntil(promise),
    passThroughOnException: () => {
      throw new Error("Staging gateway has no fallback origin.");
    },
  };
  const ASSETS = { fetch: async () => new Response(null, { status: 404 }) };
  return apiMiddleware({
    ...base,
    env: { TELEMETRY: requestSummaryLog(() => summaryReason), ASSETS },
    async next(input, init) {
      try {
        if (
          bindings.ENVIRONMENT !== "staging" ||
          !bindings.ACCOUNT_AUTH_SECRET ||
          !bindings.PROVIDER_SIGNING_PRIVATE_JWK ||
          !bindings.PROVIDER_ENCRYPTION_PRIVATE_JWK ||
          !bindings.R2_BUCKET ||
          !bindings.DB
        )
          return rejected(503, "staging_configuration_unavailable");
        if (
          selection.mode === "state-plane" &&
          !isBranchStateRpcStub(bindings.STATE_PLANE)
        )
          return rejected(503, "staging_configuration_unavailable");
        const forwarded = input
          ? new Request<unknown, IncomingRequestCfProperties>(input, {
              ...init,
              cf: request.cf,
            })
          : request;
        let legacySourceWriter:
          ReturnType<typeof createLegacySourceWriter> | undefined;
        if (selection.mode === "fenced-legacy") {
          const authority = selection.authority;
          if (
            !authority ||
            !Number.isSafeInteger(authority.generation) ||
            authority.generation < 0 ||
            !authority.admission ||
            typeof authority.admission.admit !== "function" ||
            typeof authority.admission.complete !== "function"
          )
            return rejected(503, "staging_configuration_unavailable");
          try {
            const captured = BranchStateQuery.head({
              target: authority.target,
              placement: {
                routingVersion: 1,
                generation: authority.generation,
              },
            });
            const target = captured.target;
            const requestId =
              forwarded.headers.get("x-request-id") ?? crypto.randomUUID();
            const operationId =
              forwarded.headers.get("x-operation-id") ?? crypto.randomUUID();
            legacySourceWriter = createLegacySourceWriter({
              target,
              generation: captured.placement.generation,
              admission: authority.admission,
              observe(event) {
                try {
                  console.info(
                    JSON.stringify({
                      event: "source.writer",
                      version: 1,
                      requestId,
                      operationId,
                      admissionId: event.requestId,
                      operation: event.operation satisfies SourceMutationKind,
                      generation: event.generation,
                      outcome: event.outcome,
                      reason: event.reason,
                    }),
                  );
                } catch {
                  // Diagnostics never grant admission or change a source write result.
                }
              },
            });
          } catch {
            return rejected(503, "staging_configuration_unavailable");
          }
        }
        const selectedState = isBranchStateRpcStub(bindings.STATE_PLANE)
          ? bindings.STATE_PLANE
          : undefined;
        const validatedBindings = {
          ENVIRONMENT: bindings.ENVIRONMENT,
          R2_BUCKET: bindings.R2_BUCKET,
          DB: bindings.DB,
          STATE_PLANE: selectedState,
          PROVIDER_ENCRYPTION_PRIVATE_JWK:
            bindings.PROVIDER_ENCRYPTION_PRIVATE_JWK,
        };
        const requestId = forwarded.headers.get("x-request-id");
        const operationId = forwarded.headers.get("x-operation-id");
        const route = routes.find((candidate) => candidate.pattern.test(path));
        if (!route) return rejected(404, "not_found");
        const match = route.pattern.exec(path)!;
        const params = { ...base.params };
        try {
          route.params.forEach((key, index) => {
            params[key] = decodeURIComponent(match[index + 1]);
          });
        } catch {
          return rejected(400, "invalid_route_parameter");
        }
        const statePlane = selectedState
          ? new Proxy(selectedState, {
              get(target, property) {
                const method = Reflect.get(target, property, target);
                if (typeof method !== "function") return method;
                return async (...args: unknown[]) => {
                  const started = performance.now();
                  let outcome = "success";
                  let reason = "completed";
                  try {
                    const result: unknown = await Reflect.apply(
                      method,
                      target,
                      args,
                    );
                    if (
                      typeof result === "object" &&
                      result !== null &&
                      "ok" in result &&
                      result.ok === false
                    ) {
                      outcome = "failure";
                      const code =
                        "error" in result &&
                        typeof result.error === "object" &&
                        result.error !== null &&
                        "code" in result.error &&
                        typeof result.error.code === "string"
                          ? result.error.code
                          : "state_unavailable";
                      reason = Object.hasOwn(BRANCH_STATE_ERRORS, code)
                        ? code
                        : "state_unavailable";
                    }
                    return result;
                  } catch (error) {
                    outcome = "failure";
                    const code =
                      typeof error === "object" &&
                      error !== null &&
                      "code" in error &&
                      typeof error.code === "string"
                        ? error.code
                        : "state_unavailable";
                    reason = Object.hasOwn(BRANCH_STATE_ERRORS, code)
                      ? code
                      : "state_unavailable";
                    throw error;
                  } finally {
                    try {
                      // This measures only the gateway's RPC boundary; it does not
                      // expose or claim coverage of DO-internal SQL execution.
                      console.info(
                        JSON.stringify({
                          event: "state_plane.rpc",
                          version: 1,
                          environment: "staging",
                          requestId,
                          operationId,
                          method: String(property),
                          durationMs: performance.now() - started,
                          outcome,
                          reason,
                        }),
                      );
                    } catch {
                      // Diagnostics must never change an RPC result.
                    }
                  }
                };
              },
            })
          : undefined;
        const env = {
          ...bindings,
          STATE_PLANE: statePlane,
          ASSETS,
          PUBLIC_BASE_URL:
            bindings.PUBLIC_BASE_URL ?? new URL(request.url).origin,
          ALLOW_INSECURE_ACCOUNT_HEADER: "0" as const,
          ...(selection.mode === "fenced-legacy"
            ? {
                legacySourceWriter: legacySourceWriter!,
                localBranchApplication: undefined,
              }
            : {
                legacySourceWriter: undefined,
                localBranchApplication: createStagingBranchApplication({
                  ...validatedBindings,
                  STATE_PLANE: statePlane!,
                }),
              }),
        } satisfies ApplicationEnvironment & {
          STATE_PLANE?: BranchStateRpcStub;
        };
        const response = await route.handler({
          ...base,
          request: forwarded,
          params,
          env,
          next: async () => new Response(null, { status: 404 }),
        });
        const result = new Response(response.body, response);
        summaryReason = responseReason(path, result);
        if (!result.headers.has("x-diagnostic-reason"))
          result.headers.set("x-diagnostic-reason", summaryReason);
        return result;
      } catch {
        return rejected(503, "state_unavailable");
      }
    },
  });
}

export default {
  fetch(request, env, execution) {
    return fetchStagingApplication(
      request,
      {
        ENVIRONMENT: env.ENVIRONMENT,
        R2_BUCKET: env.R2_BUCKET,
        DB: env.DB,
        STATE_PLANE: env.STATE_PLANE,
        ACCOUNT_AUTH_SECRET: env.ACCOUNT_AUTH_SECRET,
        ACCOUNT_AUTH_TOKEN_TTL_MS: env.ACCOUNT_AUTH_TOKEN_TTL_MS,
        PROVIDER_ENCRYPTION_PRIVATE_JWK: env.PROVIDER_ENCRYPTION_PRIVATE_JWK,
        PROVIDER_SIGNING_PRIVATE_JWK: env.PROVIDER_SIGNING_PRIVATE_JWK,
        PUBLIC_BASE_URL: env.PUBLIC_BASE_URL,
        LOG_LEVEL: env.LOG_LEVEL,
      },
      execution,
    );
  },
} satisfies ExportedHandler<
  StagingApiEnv &
    Pick<
      StagingApplicationDependencies,
      | "ACCOUNT_AUTH_SECRET"
      | "PROVIDER_ENCRYPTION_PRIVATE_JWK"
      | "PROVIDER_SIGNING_PRIVATE_JWK"
    > &
    Partial<
      Pick<
        StagingApplicationDependencies,
        "ACCOUNT_AUTH_TOKEN_TTL_MS" | "PUBLIC_BASE_URL" | "LOG_LEVEL"
      >
    >
>;

import type {
  ExecutionContext,
  IncomingRequestCfProperties,
} from "@cloudflare/workers-types";
import {
  DROP_ID_LENGTH,
  isDropIdToken,
  toShortDropId,
} from "../../../shared/drop/id";
import { ApiHttpError } from "../../../functions/api/_lib/core/http/responses";
import {
  RpcBranchAuthorityClient,
  type BranchAuthorityRpcStub,
} from "./authority-router";
import type { BranchStateRpcStub } from "./shard-router";
import {
  fetchAuthorityProductionApplication,
  type StagingApplicationDependencies,
} from "./staging-api";

/** Deployment-owned enrollment and platform ports; never populated from request headers. */
export interface ProductionIngressBindings extends Partial<StagingApplicationDependencies> {
  STATE_PLANE_CANARY_ROOT?: string;
  STATE_PLANE?: BranchStateRpcStub & BranchAuthorityRpcStub;
}

const reject = (status: number, code: string) =>
  Response.json(
    { error: code, code },
    {
      status,
      headers: { "Cache-Control": "no-store", "x-diagnostic-reason": code },
    },
  );

const member = (value: unknown, key: string): unknown =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? Reflect.get(value, key)
    : undefined;

// Inspect only bounded bytes of a cloned body; cancelling one tee must not wait for its other reader.
async function readSelectionBody(request: Request): Promise<unknown> {
  const reader = request.clone().body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 512_000)
        throw new ApiHttpError({
          status: 413,
          code: "body_too_large",
          message: "Nullplug request exceeds its byte limit.",
        });
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    void reader.cancel().catch(() => {});
  }
}

/** Tests exact canonical and standard short-link identity without querying or changing an alias. */
export function isEnrolledRoot(candidate: unknown, root: string): boolean {
  return (
    typeof candidate === "string" &&
    [root, toShortDropId(root)].includes(candidate.trim())
  );
}

/** Selects only an enrolled root's request; null leaves unrelated Pages routes on their existing composition. */
export async function fetchProductionEnrollment(
  request: Request<unknown, IncomingRequestCfProperties>,
  env: ProductionIngressBindings,
  execution: Pick<ExecutionContext, "waitUntil">,
): Promise<Response | null> {
  const root = env.STATE_PLANE_CANARY_ROOT;
  if (root === undefined || root === "") return null;
  if (!isDropIdToken(root) || root.length !== DROP_ID_LENGTH)
    return reject(503, "state_unavailable");
  const url = new URL(request.url);
  let segments: string[];
  try {
    segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (segments.some((part) => /[%/\\\u0000]/.test(part)))
      return reject(400, "invalid_route_parameter");
  } catch {
    return reject(400, "invalid_route_parameter");
  }
  // Match the route identity before checking enrollment, including encoded fixed segments.
  url.pathname = "/" + segments.map(encodeURIComponent).join("/");
  if (/^\/api\/(metadata|index)\/backfill\/?$/.test(url.pathname))
    return reject(501, "capability_unsupported");
  const parts = ["", ...segments];
  const rootIndex =
    parts[2] === "branches"
      ? ["resolve", "backfill"].includes(parts[3])
        ? 4
        : 3
      : parts[2] === "diff-auth" && parts[3] === "register"
        ? 4
        : ["get", "diff", "delete", "unlock"].includes(parts[2])
          ? 3
          : -1;
  let selected = false;
  if (rootIndex >= 0 && parts[rootIndex]) {
    selected = isEnrolledRoot(parts[rootIndex], root);
    if (selected) {
      parts[rootIndex] = root;
      url.pathname = parts.map(encodeURIComponent).join("/");
    }
  }
  if (
    /^\/api\/nullplug\/(state|submit|resolve)\/?$/.test(url.pathname) &&
    request.method === "POST"
  ) {
    try {
      const body = await readSelectionBody(request);
      if (url.pathname === "/api/nullplug/resolve") {
        const caller = member(member(body, "call"), "caller");
        const context = member(body, "context");
        if (
          isEnrolledRoot(member(caller, "dropId"), root) ||
          isEnrolledRoot(member(context, "callerDropId"), root)
        )
          return reject(501, "capability_unsupported");
      } else {
        selected = isEnrolledRoot(
          member(member(body, "source"), "rootDropId"),
          root,
        );
      }
    } catch (error) {
      if (error instanceof ApiHttpError)
        return reject(error.status, error.code);
      return reject(400, "invalid_request");
    }
  }
  if (!selected) return null;
  if (
    !env.STATE_PLANE ||
    !env.R2_BUCKET ||
    !env.DB ||
    !env.ACCOUNT_AUTH_SECRET ||
    !env.PROVIDER_ENCRYPTION_PRIVATE_JWK ||
    !env.PROVIDER_SIGNING_PRIVATE_JWK
  )
    return reject(503, "state_unavailable");
  return fetchAuthorityProductionApplication(
    new Request(url, request),
    {
      ...env,
      ENVIRONMENT: "production",
      R2_BUCKET: env.R2_BUCKET,
      DB: env.DB,
      ACCOUNT_AUTH_SECRET: env.ACCOUNT_AUTH_SECRET,
      PROVIDER_ENCRYPTION_PRIVATE_JWK: env.PROVIDER_ENCRYPTION_PRIVATE_JWK,
      PROVIDER_SIGNING_PRIVATE_JWK: env.PROVIDER_SIGNING_PRIVATE_JWK,
      STATE_PLANE: env.STATE_PLANE,
      BRANCH_AUTHORITY: {
        target: { rootDropId: root, branchId: "owner" },
        client: new RpcBranchAuthorityClient(() => env.STATE_PLANE!),
      },
    },
    execution,
  );
}

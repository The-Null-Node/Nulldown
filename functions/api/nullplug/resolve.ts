import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { handleNullplugResolveRequest } from "../_lib/nullplug/resolve-controller";
import { createCloudflareBackendRuntime } from "../_lib/core/platform/cloudflare/runtime/composition";
import {
  createCloudflareBlobStore,
  createCloudflareSqlStore,
} from "../_lib/core/platform/cloudflare/storage";

interface Env {
  R2_BUCKET: R2Bucket;
  DB?: D1Database;
  PROVIDER_ENCRYPTION_PRIVATE_JWK?: string;
  NULLPLUG_REGISTRY_ALLOWED_HOSTS?: string;
  ACCOUNT_AUTH_SECRET?: string;
  ACCOUNT_AUTH_TOKEN_TTL_MS?: string;
  ALLOW_INSECURE_ACCOUNT_HEADER?: string;
  fetchImpl?: typeof fetch;
}

/** Cloudflare Pages adapter for the portable Nullplug resolve controller. */
export const onRequest: PagesFunction<Env> = async ({ env, request }) =>
  (await handleNullplugResolveRequest({
    request: request as unknown as Request,
    env: {
      R2_BUCKET: createCloudflareBlobStore(env.R2_BUCKET),
      DB: createCloudflareSqlStore(env.DB),
      ACCOUNT_AUTH_SECRET: env.ACCOUNT_AUTH_SECRET,
      ACCOUNT_AUTH_TOKEN_TTL_MS: env.ACCOUNT_AUTH_TOKEN_TTL_MS,
      ALLOW_INSECURE_ACCOUNT_HEADER: env.ALLOW_INSECURE_ACCOUNT_HEADER,
    },
    createRuntime: ({ request: authorizedRequest, caller }) =>
      createCloudflareBackendRuntime({
        ...env,
        nullplugReadRequest: authorizedRequest,
        nullplugCallerRootDropId: caller.rootDropId,
      }).serverRuntime.nullplug,
  })) as unknown as Response;

import type {
  D1Database,
  PagesFunction,
  R2Bucket,
} from "@cloudflare/workers-types";
import { handleNullplugRegistryRequest } from "../_lib/nullplug/registry-controller";
import {
  createCloudflareBlobStore,
  createCloudflareSqlStore,
} from "../_lib/core/platform/cloudflare/storage";

interface Env {
  R2_BUCKET: R2Bucket;
  DB?: D1Database;
  ACCOUNT_AUTH_SECRET?: string;
  ACCOUNT_AUTH_TOKEN_TTL_MS?: string;
  ALLOW_INSECURE_ACCOUNT_HEADER?: string;
  NULLPLUG_REGISTRY_ALLOWED_HOSTS?: string;
  NULLPLUG_REGISTRY_SIGNATURE_SECRET?: string;
  LOG_LEVEL?: string;
}

/** Cloudflare Pages adapter for the portable Nullplug registry controller. */
export const onRequest: PagesFunction<Env> = async ({ env, request }) =>
  (await handleNullplugRegistryRequest({
    request: request as unknown as Request,
    env: {
      R2_BUCKET: createCloudflareBlobStore(env.R2_BUCKET),
      DB: createCloudflareSqlStore(env.DB),
      ACCOUNT_AUTH_SECRET: env.ACCOUNT_AUTH_SECRET,
      ACCOUNT_AUTH_TOKEN_TTL_MS: env.ACCOUNT_AUTH_TOKEN_TTL_MS,
      ALLOW_INSECURE_ACCOUNT_HEADER: env.ALLOW_INSECURE_ACCOUNT_HEADER,
      NULLPLUG_REGISTRY_ALLOWED_HOSTS: env.NULLPLUG_REGISTRY_ALLOWED_HOSTS,
      NULLPLUG_REGISTRY_SIGNATURE_SECRET:
        env.NULLPLUG_REGISTRY_SIGNATURE_SECRET,
      LOG_LEVEL: env.LOG_LEVEL,
    },
  })) as unknown as Response;

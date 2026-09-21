import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { handleNullplugStateRequest } from "../_lib/nullplug/state-controller";
import {
  createCloudflareBlobStore,
  createCloudflareSqlStore,
} from "../_lib/core/platform/cloudflare-storage-adapters";

interface Env {
  R2_BUCKET: R2Bucket;
  DB?: D1Database;
  ACCOUNT_AUTH_SECRET?: string;
  ACCOUNT_AUTH_TOKEN_TTL_MS?: string;
  ALLOW_INSECURE_ACCOUNT_HEADER?: string;
}

/** Cloudflare Pages adapter for the portable Nullplug state controller. */
export const onRequest: PagesFunction<Env> = async ({ env, request }) =>
  (await handleNullplugStateRequest({
    request: request as unknown as Request,
    env: {
      R2_BUCKET: createCloudflareBlobStore(env.R2_BUCKET),
      DB: createCloudflareSqlStore(env.DB),
      ACCOUNT_AUTH_SECRET: env.ACCOUNT_AUTH_SECRET,
      ACCOUNT_AUTH_TOKEN_TTL_MS: env.ACCOUNT_AUTH_TOKEN_TTL_MS,
      ALLOW_INSECURE_ACCOUNT_HEADER: env.ALLOW_INSECURE_ACCOUNT_HEADER,
    },
  })) as unknown as Response;

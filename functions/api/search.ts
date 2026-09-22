import type { PagesFunction } from "@cloudflare/workers-types";
import { createCloudflareSqlStore } from "./_lib/core/platform/cloudflare/storage";
import {
  handleSearchGet,
  handleSearchRequest,
  type SearchEnv,
} from "./_lib/search/controller";

interface Env {
  DB: D1Database;
  LOG_LEVEL?: string;
}

const createSearchEnv = (env: Env): SearchEnv => ({
  DB: createCloudflareSqlStore(env.DB),
  LOG_LEVEL: env.LOG_LEVEL,
});

/** Adapts Pages bindings for one public search GET request. */
export const onRequestGet: PagesFunction<Env> = async ({ env, request }) =>
  handleSearchGet(request, createSearchEnv(env));

/** Adapts Pages bindings for one search request and its method dispatch. */
export const onRequest: PagesFunction<Env> = async ({ env, request }) =>
  handleSearchRequest(request, createSearchEnv(env));

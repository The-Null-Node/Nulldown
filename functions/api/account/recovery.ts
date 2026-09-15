import type { PagesFunction } from "@cloudflare/workers-types";

import type { AccountBindingEnvironment } from "../_lib/accounts/binding/service";
import {
  readRecoveryPackageResponse,
  writeRecoveryPackageResponse,
} from "../_lib/accounts/recovery/service";

export const onRequestGet: PagesFunction<AccountBindingEnvironment> = ({ env, request }) =>
  readRecoveryPackageResponse(env, request);

export const onRequestPut: PagesFunction<AccountBindingEnvironment> = ({ env, request }) =>
  writeRecoveryPackageResponse(env, request);

export const onRequest: PagesFunction<AccountBindingEnvironment> = (context) => {
  if (context.request.method === "GET") return onRequestGet(context);
  if (context.request.method === "PUT") return onRequestPut(context);
  return new Response("Method Not Allowed", { status: 405 });
};

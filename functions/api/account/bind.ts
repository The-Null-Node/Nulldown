import type { PagesFunction } from "@cloudflare/workers-types";

import {
  bindAccountResponse,
  type AccountBindingEnvironment,
} from "../_lib/accounts/binding/service";

export const onRequestPost: PagesFunction<AccountBindingEnvironment> = ({ env, request }) =>
  bindAccountResponse(env, request);

export const onRequest: PagesFunction<AccountBindingEnvironment> = (context) =>
  context.request.method === "POST"
    ? onRequestPost(context)
    : new Response("Method Not Allowed", { status: 405 });

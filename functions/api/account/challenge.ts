import type { PagesFunction } from "@cloudflare/workers-types";

import {
  createBindingChallengeResponse,
  type AccountBindingEnvironment,
} from "../_lib/accounts/binding/service";

export const onRequestPost: PagesFunction<AccountBindingEnvironment> = ({ env, request }) =>
  createBindingChallengeResponse(env, request);

export const onRequest: PagesFunction<AccountBindingEnvironment> = (context) =>
  context.request.method === "POST"
    ? onRequestPost(context)
    : new Response("Method Not Allowed", { status: 405 });

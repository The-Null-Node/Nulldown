import type { PagesFunction } from "@cloudflare/workers-types";

import { completeOpenAuthCallback, type OpenAuthBffEnvironment } from "../../_lib/accounts/open-auth/service";

export const onRequestGet: PagesFunction<OpenAuthBffEnvironment> = ({ env, request }) =>
  completeOpenAuthCallback(env, request);

export const onRequest: PagesFunction<OpenAuthBffEnvironment> = (context) =>
  context.request.method === "GET"
    ? onRequestGet(context)
    : new Response("Method Not Allowed", { status: 405 });

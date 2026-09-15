import type { PagesFunction } from "@cloudflare/workers-types";

import { readOpenAuthPrincipal, type OpenAuthBffEnvironment } from "../../_lib/accounts/openAuth/service";

export const onRequestGet: PagesFunction<OpenAuthBffEnvironment> = ({ env, request }) =>
  readOpenAuthPrincipal(env, request);

export const onRequest: PagesFunction<OpenAuthBffEnvironment> = (context) =>
  context.request.method === "GET"
    ? onRequestGet(context)
    : new Response("Method Not Allowed", { status: 405 });

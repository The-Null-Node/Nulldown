import type { PagesFunction } from "@cloudflare/workers-types";

import { logoutOpenAuth, type OpenAuthBffEnvironment } from "../../_lib/accounts/openAuth/service";

export const onRequestPost: PagesFunction<OpenAuthBffEnvironment> = ({ env, request }) =>
  logoutOpenAuth(env, request);

export const onRequest: PagesFunction<OpenAuthBffEnvironment> = (context) =>
  context.request.method === "POST"
    ? onRequestPost(context)
    : new Response("Method Not Allowed", { status: 405 });

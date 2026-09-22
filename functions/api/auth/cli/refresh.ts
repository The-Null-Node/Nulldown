import type { PagesFunction } from "@cloudflare/workers-types";

import {
  refreshCliCredentialResponse,
  type CliAuthEnvironment,
} from "../../_lib/accounts/cli-auth/service";

export const onRequestPost: PagesFunction<CliAuthEnvironment> = ({ env, request }) =>
  refreshCliCredentialResponse(env, request);

export const onRequest: PagesFunction<CliAuthEnvironment> = (context) =>
  context.request.method === "POST"
    ? onRequestPost(context)
    : new Response("Method Not Allowed", { status: 405 });

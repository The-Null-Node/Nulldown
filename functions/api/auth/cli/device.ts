import type { PagesFunction } from "@cloudflare/workers-types";

import {
  createCliDeviceResponse,
  type CliAuthEnvironment,
} from "../../_lib/accounts/cliAuth/service";

export const onRequestPost: PagesFunction<CliAuthEnvironment> = ({ env, request }) =>
  createCliDeviceResponse(env, request);

export const onRequest: PagesFunction<CliAuthEnvironment> = (context) =>
  context.request.method === "POST"
    ? onRequestPost(context)
    : new Response("Method Not Allowed", { status: 405 });

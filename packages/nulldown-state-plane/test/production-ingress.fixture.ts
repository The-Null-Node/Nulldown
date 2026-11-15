import { onRequest } from "../../../functions/api/_middleware";
import type { ProductionIngressBindings } from "../src/production-ingress";
import { issueAccountSessionToken } from "../../../functions/api/_lib/accounts/session/token";
import type { IncomingRequestCfProperties } from "@cloudflare/workers-types";

/** Local-only fixture for the real Pages middleware and distinct application/control bindings. */
export default {
  async fetch(
    request: Request<unknown, IncomingRequestCfProperties>,
    env: ProductionIngressBindings & {
      MIGRATION: { execute(input: unknown): Promise<unknown> };
    },
    execution: ExecutionContext,
  ): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/__control")
      return Response.json(await env.MIGRATION.execute(await request.json()));
    if (path === "/__token")
      return Response.json(
        await issueAccountSessionToken("production-fixture-owner", {
          ACCOUNT_AUTH_SECRET: env.ACCOUNT_AUTH_SECRET,
        }),
      );
    return onRequest({
      request,
      env: { ...env, ASSETS: { fetch } },
      params: {},
      data: {},
      functionPath: "/api",
      next: async () => new Response("unselected", { status: 418 }),
      waitUntil: (promise) => execution.waitUntil(promise),
      passThroughOnException: () => {
        throw Error("fallback denied");
      },
    });
  },
};

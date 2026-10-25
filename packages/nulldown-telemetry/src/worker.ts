import { readTelemetryBatch } from "../../../functions/api/_lib/core/observability/transport";
import { collectPhaseBatch } from "../../../functions/api/_lib/core/observability/ingestion";

/** Private service-binding collector; runtime logs persist only allowlisted diagnostic fields. */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const source = new URL(request.url).pathname;
    // Completion arrays and phase objects have distinct endpoint-scoped versions.
    if (request.method === "POST" && source === "/v1/phases") {
      if (
        String(env.ENVIRONMENT) !== "staging" ||
        request.url !== "https://staging-telemetry.internal/v1/phases"
      )
        return new Response(null, { status: 404 });
      return collectPhaseBatch(request);
    }
    if (request.method !== "POST" || !["/browser", "/server"].includes(source))
      return new Response(null, { status: 404 });
    if (source === "/browser") {
      const permitted = await env.BROWSER_LIMIT.limit({
        key: request.headers.get("X-Client-Key") ?? "unknown",
      });
      if (!permitted.success) return new Response(null, { status: 429 });
    }
    const events = await readTelemetryBatch(request);
    if (!events) return new Response(null, { status: 400 });
    for (const event of events) {
      const log = {
        ...event,
        source: source.slice(1),
        environment: env.ENVIRONMENT,
        receivedAt: Date.now(),
      };
      if (event.outcome === "success") console.info(JSON.stringify(log));
      else console.warn(JSON.stringify(log));
    }
    return new Response(null, { status: 204 });
  },
};

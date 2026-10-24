import type { PagesFunction } from "@cloudflare/workers-types";
import {
  deliverTelemetry,
  readTelemetryBatch,
  type TelemetryBinding,
} from "./_lib/core/observability/transport";

/** Accepts bounded same-origin browser reports; these are never treated as server identity evidence. */
export const onRequest: PagesFunction<{
  TELEMETRY?: TelemetryBinding;
}> = async (context) => {
  const { request } = context;
  if (request.method !== "POST") return new Response(null, { status: 405 });
  if (request.headers.get("Origin") !== new URL(request.url).origin)
    return new Response(null, { status: 403 });
  if (!context.env.TELEMETRY) return new Response(null, { status: 503 });
  const events = await readTelemetryBatch(request);
  if (!events) return new Response(null, { status: 400 });
  try {
    context.waitUntil(
      deliverTelemetry(
        context.env.TELEMETRY,
        events,
        "browser",
        request.headers.get("CF-Connecting-IP") ?? "unknown",
      ),
    );
  } catch {
    /* Accepted best-effort diagnostics never replace an application action. */
  }
  return new Response(null, {
    status: 202,
    headers: { "Cache-Control": "no-store" },
  });
};

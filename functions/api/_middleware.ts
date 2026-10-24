import type { PagesFunction } from "@cloudflare/workers-types";
import {
  decodeTelemetryEvent,
  isDiagnosticId,
  telemetrySurface,
} from "../../shared/observability/events";
import {
  deliverTelemetry,
  type TelemetryBinding,
} from "./_lib/core/observability/transport";

/** Adds a request-scoped diagnostic ID and records every API response without reading its body. */
export const onRequest: PagesFunction<{
  TELEMETRY?: TelemetryBinding;
}> = async (context) => {
  if (new URL(context.request.url).pathname === "/api/telemetry")
    return context.next();
  const started = Date.now();
  const candidate = context.request.headers.get("x-operation-id");
  const operationId = isDiagnosticId(candidate)
    ? candidate
    : crypto.randomUUID();
  const requestId = crypto.randomUUID();
  const headers = new Headers(context.request.headers);
  headers.set("x-request-id", requestId);
  headers.set("x-operation-id", operationId);
  let status = 500;
  let reason: string | null = null;
  try {
    const response = await context.next(
      new Request(context.request, { headers }),
    );
    status = response.status;
    reason = response.headers.get("x-diagnostic-reason");
    // Keep cookie headers separate; Headers cloning preserves the platform's Set-Cookie list.
    const result = new Response(response.body, response);
    result.headers.set("x-request-id", requestId);
    result.headers.set("x-operation-id", operationId);
    return result;
  } finally {
    try {
      const event = decodeTelemetryEvent({
        version: 1,
        event: "http.complete",
        operationId,
        requestId,
        timestamp: started,
        status,
        durationMs: Date.now() - started,
        outcome:
          status >= 500 ? "unavailable" : status >= 400 ? "failure" : "success",
        surface: telemetrySurface(new URL(context.request.url).pathname),
        reason,
      });
      if (event)
        context.waitUntil(
          deliverTelemetry(context.env.TELEMETRY, [event], "server"),
        );
    } catch {
      /* Closed request contexts and diagnostics never replace the application outcome. */
    }
  }
};

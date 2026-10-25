import {
  MAX_BYTES,
  validBatch,
} from "../../../../../shared/observability/profiling";
import { readBoundedTelemetryJson } from "./transport";

/** Private phase endpoint ingestion, called only after deployment environment gating.
 * Legacy completion arrays belong to /browser or /server, never this endpoint. */
export const collectPhaseBatch = async (
  request: Request,
): Promise<Response> => {
  if (
    request.method !== "POST" ||
    request.url !== "https://staging-telemetry.internal/v1/phases"
  )
    return new Response(null, { status: 404 });
  if (request.headers.get("content-type") !== "application/json")
    return new Response(null, { status: 415 });
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES))
    return new Response(null, { status: 413 });
  const batch = await readBoundedTelemetryJson(request, MAX_BYTES);
  if (!validBatch(batch)) return new Response(null, { status: 400 });
  for (const event of batch.events)
    console.log(
      JSON.stringify({ version: 1, environment: "staging", ...event }),
    );
  if (batch.version === 2)
    console.log(
      JSON.stringify({
        version: 2,
        environment: "staging",
        summary: batch.summary,
      }),
    );
  return new Response(null, { status: 204 });
};

/** Bounded diagnostic outcomes shared across request and browser lifetimes. */
export type TelemetryOutcome = "success" | "failure" | "unavailable";

/** Credential-free diagnostic record. Extra properties are discarded at ingestion. */
export interface TelemetryEvent {
  version: 1;
  event: "http.complete" | "session.check" | "draft.created" | "browser.error";
  operationId: string;
  requestId?: string;
  timestamp: number;
  outcome: TelemetryOutcome;
  status?: number;
  durationMs?: number;
  surface?: string;
  reason?:
    | "session_missing"
    | "authenticated"
    | "refresh_completed"
    | "principal_verification_rejected"
    | "dependency_unavailable";
}

const events = new Set([
  "http.complete",
  "session.check",
  "draft.created",
  "browser.error",
]);
const surfaces = new Set([
  "auth",
  "account",
  "branches",
  "diff",
  "store",
  "get",
  "delete",
  "list",
  "search",
  "unlock",
  "nullplug",
  "nullmem",
  "resolved",
  "other",
]);

/** Validates an opaque correlation ID without accepting arbitrary header text. */
export const isDiagnosticId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);

/** Projects a URL path to a fixed operational surface, dropping IDs and query values. */
export const telemetrySurface = (pathname: string): string => {
  const segment = pathname.split("/")[2];
  return surfaces.has(segment) ? segment : "other";
};

/** Decodes one bounded record, stripping all fields outside the telemetry contract. */
export const decodeTelemetryEvent = (value: unknown): TelemetryEvent | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    !events.has(String(record.event)) ||
    !isDiagnosticId(record.operationId) ||
    !["success", "failure", "unavailable"].includes(String(record.outcome)) ||
    typeof record.timestamp !== "number" ||
    !Number.isSafeInteger(record.timestamp) ||
    record.timestamp < 0
  )
    return null;
  const result: TelemetryEvent = {
    version: 1,
    event: record.event as TelemetryEvent["event"],
    operationId: record.operationId,
    timestamp: record.timestamp,
    outcome: record.outcome as TelemetryOutcome,
  };
  if (isDiagnosticId(record.requestId)) result.requestId = record.requestId;
  if (
    typeof record.status === "number" &&
    Number.isInteger(record.status) &&
    record.status >= 100 &&
    record.status <= 599
  )
    result.status = record.status;
  if (
    typeof record.durationMs === "number" &&
    Number.isFinite(record.durationMs) &&
    record.durationMs >= 0
  )
    result.durationMs = Math.min(Math.round(record.durationMs), 3_600_000);
  if (typeof record.surface === "string" && surfaces.has(record.surface))
    result.surface = record.surface;
  if (
    [
      "session_missing",
      "authenticated",
      "refresh_completed",
      "principal_verification_rejected",
      "dependency_unavailable",
    ].includes(String(record.reason))
  )
    result.reason = record.reason as TelemetryEvent["reason"];
  return result;
};

/** Events emitted by the CLI's verbose diagnostic stream. */
export type CliDiagnosticEvent =
  | { event: "command.start"; command: string }
  | {
      event: "command.end";
      command: string;
      durationMs: number;
      exitCode: number;
    }
  | {
      event: "command.error";
      command: string;
      durationMs: number;
      code: string;
    }
  | { event: "http.start"; requestId: string; method: string }
  | {
      event: "http.end";
      requestId: string;
      method: string;
      durationMs: number;
      status: number;
    }
  | {
      event: "http.error";
      requestId: string;
      method: string;
      durationMs: number;
      code: string;
      status?: number;
    };

/** Minimal diagnostic sink used by CLI command and transport lifecycles. */
export interface CliDiagnostics {
  /** Emits one allowlisted diagnostic event when verbose output is enabled. */
  emit(event: CliDiagnosticEvent): void;
}

interface CreateCliDiagnosticsOptions {
  enabled: boolean;
  format: "human" | "ndjson";
  write(text: string): void;
}

type DiagnosticRecord = Record<string, string | number> & {
  type: "diagnostic";
  event: CliDiagnosticEvent["event"];
};

const safeIdentifier = (value: string): string =>
  /^[a-z0-9_.:-]{1,128}$/i.test(value) ? value : "redacted";

const duration = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;

const toRecord = (event: CliDiagnosticEvent): DiagnosticRecord => {
  switch (event.event) {
    case "command.start":
      return {
        type: "diagnostic",
        event: event.event,
        command: safeIdentifier(event.command),
      };
    case "command.end":
      return {
        type: "diagnostic",
        event: event.event,
        command: safeIdentifier(event.command),
        durationMs: duration(event.durationMs),
        exitCode: event.exitCode,
      };
    case "command.error":
      return {
        type: "diagnostic",
        event: event.event,
        command: safeIdentifier(event.command),
        durationMs: duration(event.durationMs),
        code: safeIdentifier(event.code),
      };
    case "http.start":
      return {
        type: "diagnostic",
        event: event.event,
        requestId: safeIdentifier(event.requestId),
        method: safeIdentifier(event.method),
      };
    case "http.end":
      return {
        type: "diagnostic",
        event: event.event,
        requestId: safeIdentifier(event.requestId),
        method: safeIdentifier(event.method),
        durationMs: duration(event.durationMs),
        status: event.status,
      };
    case "http.error":
      return {
        type: "diagnostic",
        event: event.event,
        requestId: safeIdentifier(event.requestId),
        method: safeIdentifier(event.method),
        durationMs: duration(event.durationMs),
        code: safeIdentifier(event.code),
        ...(event.status === undefined ? {} : { status: event.status }),
      };
  }
};

const formatHuman = (record: DiagnosticRecord): string => {
  const details = Object.entries(record)
    .filter(([key]) => key !== "type" && key !== "event")
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  return `[nd] ${record.event}${details ? ` ${details}` : ""}`;
};

/** Creates a diagnostic sink that emits human lines or structured NDJSON. */
export const createCliDiagnostics = (
  options: CreateCliDiagnosticsOptions,
): CliDiagnostics => ({
  emit(event) {
    if (!options.enabled) return;
    const record = toRecord(event);
    options.write(
      options.format === "ndjson" ? JSON.stringify(record) : formatHuman(record),
    );
  },
});

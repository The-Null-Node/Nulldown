import {
  decodeTelemetryEvent,
  isDiagnosticId,
  telemetrySurface,
  type TelemetryEvent,
} from "../../../shared/observability/events";

let operationId: string | undefined;
let installed = false;
let send: typeof fetch | undefined;
let pending: TelemetryEvent[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
let sending = false;

/** Returns the current page-visit diagnostic ID; contains no account or document data. */
export const getDiagnosticId = (): string =>
  (operationId ??= crypto.randomUUID());

const flush = async (): Promise<void> => {
  if (!send || sending || !pending.length) return;
  sending = true;
  const batch = pending.splice(0, 20);
  try {
    const response = await send("/api/telemetry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(batch),
      keepalive: true,
      credentials: "same-origin",
      signal: AbortSignal.timeout(500),
      redirect: "manual",
    });
    await response.body?.cancel();
  } catch {
    // Diagnostics are best-effort and never recursively report their own transport.
  } finally {
    sending = false;
    if (pending.length && !timer)
      timer = setTimeout(() => {
        timer = undefined;
        void flush();
      }, 3000);
  }
};

/** Enqueues a bounded, allowlisted event for this browser document's lifetime. */
export const reportBrowserEvent = (
  event: TelemetryEvent["event"],
  outcome: TelemetryEvent["outcome"],
  fields: Partial<
    Pick<
      TelemetryEvent,
      "operationId" | "requestId" | "status" | "durationMs" | "surface"
    >
  > = {},
): void => {
  if (!installed) return;
  try {
    const record = decodeTelemetryEvent({
      operationId: getDiagnosticId(),
      ...fields,
      version: 1,
      event,
      outcome,
      timestamp: Date.now(),
    });
    if (!record) return;
    if (pending.length >= 60) pending.shift();
    pending.push(record);
    if (!timer)
      timer = setTimeout(() => {
        timer = undefined;
        void flush();
      }, 1000);
  } catch {
    // Storage, crypto, and diagnostics failures must not prevent editor actions.
  }
};

/** Installs same-origin API diagnostics once per browser document, preserving response bodies. */
export const installBrowserTelemetry = (): void => {
  if (installed || typeof window === "undefined") return;
  send = window.fetch.bind(window);
  const transport = send;
  installed = true;
  window.fetch = async (input, init) => {
    const url = new URL(
      input instanceof Request ? input.url : String(input),
      location.href,
    );
    if (
      url.origin !== location.origin ||
      !url.pathname.startsWith("/api/") ||
      url.pathname === "/api/telemetry"
    )
      return transport(input, init);
    let headers: Headers;
    try {
      headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );
      if (!isDiagnosticId(headers.get("x-operation-id")))
        headers.set("x-operation-id", getDiagnosticId());
    } catch {
      return transport(input, init);
    }
    const started = performance.now();
    try {
      const response = await transport(input, { ...init, headers });
      reportBrowserEvent(
        "http.complete",
        response.ok
          ? "success"
          : response.status >= 500
            ? "unavailable"
            : "failure",
        {
          status: response.status,
          durationMs: performance.now() - started,
          operationId: headers.get("x-operation-id")!,
          requestId: response.headers.get("x-request-id") ?? undefined,
          surface: telemetrySurface(url.pathname),
        },
      );
      return response;
    } catch (error) {
      reportBrowserEvent("http.complete", "unavailable", {
        operationId: headers.get("x-operation-id")!,
        durationMs: performance.now() - started,
        surface: telemetrySurface(url.pathname),
      });
      throw error;
    }
  };
  window.addEventListener("error", () =>
    reportBrowserEvent("browser.error", "failure"),
  );
  window.addEventListener("unhandledrejection", () =>
    reportBrowserEvent("browser.error", "failure"),
  );
  window.addEventListener("pagehide", () => {
    void flush();
  });
};

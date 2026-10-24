import {
  decodeTelemetryEvent,
  type TelemetryEvent,
} from "../../../../../shared/observability/events";

/** Optional service-binding port; each caller owns its request's delivery promise. */
export interface TelemetryBinding {
  fetch(input: Request): Promise<Response>;
}
/** Shared absolute telemetry lifetime; never an application request deadline. */
export const TELEMETRY_DEADLINE_MS = 500;

/** Reads bounded JSON for private ingestion; stalled/empty streams are bounded too. */
export const readBoundedTelemetryJson = async (
  request: Request,
  maxBytes: number,
): Promise<unknown> => {
  if (!request.body) return null;
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes))
    return null;
  const reader = request.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const read = async () => {
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (let reads = 0; reads < 256; reads++) {
        const part = await reader.read();
        if (part.done) {
          const bytes = new Uint8Array(size);
          let at = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, at);
            at += chunk.byteLength;
          }
          return JSON.parse(
            new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
              bytes,
            ),
          ) as unknown;
        }
        size += part.value.byteLength;
        if (size > maxBytes) throw Error();
        chunks.push(part.value);
      }
      throw Error();
    };
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        void reader.cancel().catch(() => undefined);
        resolve(null);
      }, TELEMETRY_DEADLINE_MS);
    });
    return await Promise.race([read(), deadline]);
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    void reader.cancel().catch(() => undefined);
  }
};

/** One bounded, no-follow, strict204 service-binding send; all telemetry callers share it. */
export const sendTelemetryBatch = async (
  binding: TelemetryBinding | undefined,
  body: string,
  source: "browser" | "server" | "phases",
  clientKey = "unknown",
): Promise<void> => {
  if (!binding) return;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve();
      }, TELEMETRY_DEADLINE_MS);
    });
    const send = Promise.resolve()
      .then(() =>
        binding.fetch(
          new Request(
            source === "phases"
              ? "https://staging-telemetry.internal/v1/phases"
              : `https://telemetry.internal/${source}`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...(source === "phases" ? {} : { "X-Client-Key": clientKey }),
              },
              body,
              signal: controller.signal,
              redirect: "manual",
            },
          ),
        ),
      )
      .then((response) => {
        if (response.body) void response.body.cancel().catch(() => undefined);
        if (response.status !== 204) throw Error();
      })
      .catch(() => undefined);
    await Promise.race([send, deadline]);
  } catch {
    /* Never replace the application outcome. */
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

/** Reads an ingestion body with a hard byte cap even when Content-Length is absent. */
export const readTelemetryBatch = async (
  request: Request,
): Promise<TelemetryEvent[] | null> => {
  try {
    const values: unknown = await readBoundedTelemetryJson(request, 16_384);
    if (!Array.isArray(values) || values.length === 0 || values.length > 20)
      return null;
    const events = values.map(decodeTelemetryEvent);
    return events.every((event): event is TelemetryEvent => event !== null)
      ? events
      : null;
  } catch {
    return null;
  }
};

/** Best-effort delivery; callers await it or attach it to their own waitUntil. */
export const deliverTelemetry = async (
  binding: TelemetryBinding | undefined,
  events: TelemetryEvent[],
  source: "browser" | "server",
  clientKey = "unknown",
): Promise<void> => {
  await sendTelemetryBatch(binding, JSON.stringify(events), source, clientKey);
};

type LogLevel = "debug" | "info" | "warn" | "error";

type LogFields = Record<string, unknown>;

const DEFAULT_LOG_LEVEL: LogLevel = "info";

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const isLogLevel = (value: string): value is LogLevel =>
  value === "debug" ||
  value === "info" ||
  value === "warn" ||
  value === "error";

const cleanFields = (fields: LogFields): LogFields =>
  Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  );

const resolveLogLevel = (env: unknown): LogLevel => {
  if (!env || typeof env !== "object") {
    return DEFAULT_LOG_LEVEL;
  }

  const raw = (env as Record<string, unknown>).LOG_LEVEL;
  if (typeof raw !== "string") {
    return DEFAULT_LOG_LEVEL;
  }

  const normalized = raw.trim().toLowerCase();
  return isLogLevel(normalized) ? normalized : DEFAULT_LOG_LEVEL;
};

const hashString = (value: string): number => {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
};

const normalizeSampleRate = (value: number | undefined): number => {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return 1;
  }

  return Math.min(1, Math.max(0, value));
};

const isSampled = (sampleRate: number, seed: string): boolean => {
  if (sampleRate <= 0) {
    return false;
  }

  if (sampleRate >= 1) {
    return true;
  }

  const bucket = hashString(seed) % 1000;
  return bucket < Math.floor(sampleRate * 1000);
};

const resolvePathname = (url: string): string => {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
};

const resolveRequestId = (
  request: Request,
): { requestId: string; cfRay?: string } => {
  const fromHeader = request.headers.get("x-request-id")?.trim();
  const cfRay = request.headers.get("cf-ray")?.trim() || undefined;

  return {
    requestId: fromHeader || cfRay || crypto.randomUUID(),
    cfRay,
  };
};

const selectConsole = (level: LogLevel) => {
  if (level === "debug") return console.debug;
  if (level === "info") return console.info;
  if (level === "warn") return console.warn;
  return console.error;
};

const serializeUnknown = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

/** Serializes unknown thrown values for structured request logs. */
export const serializeError = (error: unknown): Record<string, unknown> => {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return {
    message: serializeUnknown(error),
  };
};

/** Redacts an identifier into a stable length/hash reference for logs. */
export const toLogRef = (
  value: string | null | undefined,
): string | undefined => {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  return `len:${trimmed.length},h:${hashString(trimmed).toString(36)}`;
};

/** Structured request logger shared by route services. */
export interface RequestLogger {
  requestId: string;
  debug: (event: string, fields?: LogFields) => void;
  info: (event: string, fields?: LogFields) => void;
  warn: (event: string, fields?: LogFields) => void;
  error: (event: string, fields?: LogFields) => void;
  logStart: (fields?: LogFields) => void;
  logEnd: (status: number, fields?: LogFields) => void;
  logError: (event: string, error: unknown, fields?: LogFields) => void;
}

interface CreateRequestLoggerOptions {
  request: Request;
  env?: unknown;
  route: string;
  successSampleRate?: number;
}

/** Creates a request-scoped structured logger with sampling support. */
export const createRequestLogger = ({
  request,
  env,
  route,
  successSampleRate,
}: CreateRequestLoggerOptions): RequestLogger => {
  const levelThreshold = resolveLogLevel(env);
  const sampledSuccessRate = normalizeSampleRate(successSampleRate);
  const startedAt = Date.now();
  const pathname = resolvePathname(request.url);
  const method = request.method;
  const { requestId, cfRay } = resolveRequestId(request);
  const sampledRequest = isSampled(
    sampledSuccessRate,
    `${requestId}:${method}:${route}:${pathname}`,
  );

  const baseFields = cleanFields({
    route,
    method,
    path: pathname,
    requestId,
    cfRay,
  });

  const emit = (level: LogLevel, event: string, fields: LogFields = {}) => {
    if (LOG_LEVEL_ORDER[level] < LOG_LEVEL_ORDER[levelThreshold]) {
      return;
    }

    const payload = JSON.stringify(
      cleanFields({
        ts: new Date().toISOString(),
        level,
        event,
        ...baseFields,
        ...fields,
      }),
    );

    selectConsole(level)(payload);
  };

  const shouldLogStart = sampledSuccessRate >= 1 || sampledRequest;

  return {
    requestId,
    debug: (event, fields) => emit("debug", event, fields),
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
    logStart: (fields) => {
      if (shouldLogStart) {
        emit("info", "request.start", fields);
      }
    },
    logEnd: (status, fields) => {
      const isSuccessful = status >= 200 && status < 400;
      if (isSuccessful && sampledSuccessRate < 1 && !sampledRequest) {
        return;
      }

      const durationMs = Date.now() - startedAt;
      const level = status >= 500 ? "error" : status >= 400 ? "warn" : "info";

      emit(level, "request.end", {
        status,
        durationMs,
        ...fields,
      });
    },
    logError: (event, error, fields) => {
      const durationMs = Date.now() - startedAt;

      emit("error", event, {
        durationMs,
        error: serializeError(error),
        ...fields,
      });
    },
  };
};

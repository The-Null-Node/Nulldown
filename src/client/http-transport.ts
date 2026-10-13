/** Fetch-compatible function accepted by the portable HTTP transport. */
export type NulldownHttpFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** Response parsing mode for one portable HTTP request. */
export type NulldownHttpResponseMode = "auto" | "json" | "text";

/** Options for one portable HTTP request. */
export interface NulldownHttpRequestOptions {
  /** Fetch request options supplied by the caller. */
  init?: RequestInit;
  /** Optional request deadline in milliseconds. */
  timeoutMs?: number;
  /** Response parser selection. Defaults to `auto`. */
  responseMode?: NulldownHttpResponseMode;
}

/** Parsed response returned by the portable HTTP transport. */
export interface NulldownHttpResponse<T = unknown> {
  /** Whether the HTTP status is in the successful range. */
  ok: boolean;
  /** HTTP status code. */
  status: number;
  /** HTTP status text. */
  statusText: string;
  /** Response headers. */
  headers: Headers;
  /** Raw response text, read exactly once. */
  text: string;
  /** Parsed JSON data when available. */
  data: T | null;
}

/** Stable transport failure raised before an endpoint adapter interprets a response. */
export class NulldownHttpTransportError extends Error {
  /** Stable transport or API error code. */
  readonly code: string;
  /** HTTP status when the failure came from a response. */
  readonly status?: number;

  constructor(
    message: string,
    options: { code: string; status?: number; cause?: unknown },
  ) {
    super(message, { cause: options.cause });
    this.name = "NulldownHttpTransportError";
    this.code = options.code;
    this.status = options.status;
  }
}

const MAX_REQUEST_TIMEOUT_MS = 2_147_483_647;

const parseJson = (
  text: string,
): { valid: true; data: unknown } | { valid: false } => {
  try {
    return { valid: true, data: text ? JSON.parse(text) : null };
  } catch {
    return { valid: false };
  }
};

const isJsonContentType = (headers: Headers): boolean =>
  (() => {
    const mediaType = headers
      .get("Content-Type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    return (
      mediaType === "application/json" || mediaType?.endsWith("+json") === true
    );
  })();

const readResponse = async <T>(
  response: Response,
  mode: NulldownHttpResponseMode,
): Promise<NulldownHttpResponse<T>> => {
  const text = await response.text();
  const parsed = mode === "text" ? { valid: false as const } : parseJson(text);
  if (
    response.ok &&
    text.trim() &&
    !parsed.valid &&
    (mode === "json" || isJsonContentType(response.headers))
  ) {
    throw new NulldownHttpTransportError("Response body was not valid JSON.", {
      code: "invalid_json_response",
      status: response.status,
    });
  }
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    text,
    data: (parsed.valid ? parsed.data : null) as T | null,
  };
};

/** Converts a parsed non-success response into the stable transport error shape. */
export const createNulldownHttpResponseError = (
  response: NulldownHttpResponse,
): NulldownHttpTransportError => {
  const body =
    response.data && typeof response.data === "object"
      ? (response.data as Record<string, unknown>)
      : null;
  const message =
    body && "error" in body
      ? String(body.error)
      : response.text || `${response.status} ${response.statusText}`;
  const code = body && "code" in body ? String(body.code) : "http_error";
  return new NulldownHttpTransportError(message, {
    code,
    status: response.status,
  });
};

/** Executes one fetch request with bounded cancellation and deterministic parsing. */
export const requestNulldownHttp = async <T = unknown>(
  fetchImpl: NulldownHttpFetch,
  url: string,
  options: NulldownHttpRequestOptions = {},
): Promise<NulldownHttpResponse<T>> => {
  if (
    options.timeoutMs !== undefined &&
    (!Number.isInteger(options.timeoutMs) ||
      options.timeoutMs < 1 ||
      options.timeoutMs > MAX_REQUEST_TIMEOUT_MS)
  ) {
    throw new NulldownHttpTransportError(
      `Request timeout must be an integer from 1 to ${MAX_REQUEST_TIMEOUT_MS}.`,
      { code: "invalid_request_timeout" },
    );
  }
  const init = options.init ?? {};
  const externalSignal = init.signal;
  const controller = new AbortController();
  let abortSource: "caller" | "timeout" | null = null;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const abortFromCaller = (): void => {
    if (abortSource) return;
    abortSource = "caller";
    controller.abort(externalSignal?.reason);
  };

  if (externalSignal?.aborted) abortFromCaller();
  else
    externalSignal?.addEventListener("abort", abortFromCaller, { once: true });
  if (options.timeoutMs !== undefined) {
    timeout = setTimeout(() => {
      if (abortSource) return;
      abortSource = "timeout";
      controller.abort();
    }, options.timeoutMs);
  }

  try {
    if (abortSource === "caller") {
      throw new NulldownHttpTransportError("Request was aborted.", {
        code: "request_aborted",
      });
    }
    const response = await fetchImpl(url, {
      ...init,
      signal: controller.signal,
    });
    return await readResponse<T>(response, options.responseMode ?? "auto");
  } catch (error) {
    if (error instanceof NulldownHttpTransportError) throw error;
    if (abortSource === "timeout") {
      throw new NulldownHttpTransportError("Request timed out.", {
        code: "request_timeout",
        cause: error,
      });
    }
    if (abortSource === "caller") {
      throw new NulldownHttpTransportError("Request was aborted.", {
        code: "request_aborted",
        cause: error,
      });
    }
    throw new NulldownHttpTransportError("Request failed.", {
      code: "request_failed",
      cause: error,
    });
  } finally {
    if (timeout) clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", abortFromCaller);
  }
};

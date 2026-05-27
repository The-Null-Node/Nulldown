interface ApiErrorResponse {
  error?: string;
  code?: string;
  details?: unknown;
}

/** HTTP error wrapper emitted by remote void provider storage. */
export class VoidProviderHttpError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly details: unknown;

  constructor(input: {
    status: number;
    message: string;
    code?: string | null;
    details?: unknown;
  }) {
    super(input.message);
    this.name = "VoidProviderHttpError";
    this.status = input.status;
    this.code = input.code ?? null;
    this.details = input.details;
  }
}

/** Returns true when a value is a remote void provider HTTP error. */
export const isVoidProviderHttpError = (
  value: unknown,
): value is VoidProviderHttpError => value instanceof VoidProviderHttpError;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const parseApiErrorBody = (raw: string): ApiErrorResponse | null => {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }

    return {
      error: typeof parsed.error === "string" ? parsed.error : undefined,
      code: typeof parsed.code === "string" ? parsed.code : undefined,
      details: parsed.details,
    };
  } catch {
    return null;
  }
};

/** Converts a failed fetch response into a typed void provider HTTP error. */
export const createHttpErrorFromResponse = async (
  response: Response,
  fallbackMessage: string,
): Promise<VoidProviderHttpError> => {
  const rawBody = await response.text();
  const apiError = parseApiErrorBody(rawBody);
  const bodyMessage = apiError?.error || rawBody || response.statusText;

  return new VoidProviderHttpError({
    status: response.status,
    code: apiError?.code ?? null,
    details: apiError?.details,
    message: `${response.status}: ${bodyMessage || fallbackMessage}`,
  });
};

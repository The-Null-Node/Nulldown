import { z } from "zod";

const textEncoder = new TextEncoder();

/** Primitive JSON values accepted by route parsing helpers. */
export type JsonPrimitive = string | number | boolean | null;
/** Recursive JSON value type accepted by route parsing helpers. */
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Public validation issue shape returned in structured API errors. */
export interface ApiValidationIssue {
  path: Array<string | number>;
  code: string;
  message: string;
}

/** Route-service error that can be converted to a structured HTTP response. */
export class ApiHttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: object;

  constructor(input: {
    status: number;
    code: string;
    message: string;
    details?: object;
  }) {
    super(input.message);
    this.name = "ApiHttpError";
    this.status = input.status;
    this.code = input.code;
    this.details = input.details;
  }
}

/** Type guard for structured route-service HTTP errors. */
export const isApiHttpError = (error: unknown): error is ApiHttpError =>
  error instanceof ApiHttpError;

/** Creates a JSON response with the standard API content type. */
export const jsonResponse = (body: object, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });

/** Creates a structured JSON API error response. */
export const jsonErrorResponse = (
  status: number,
  code: string,
  error: string,
  details?: object,
): Response =>
  jsonResponse(
    details === undefined
      ? { error, code }
      : {
          error,
          code,
          details,
        },
    status,
  );

/** Converts an ApiHttpError into its HTTP response. */
export const apiHttpErrorResponse = (error: ApiHttpError): Response =>
  jsonErrorResponse(error.status, error.code, error.message, error.details);

/** Returns the standard method-not-allowed API response. */
export const methodNotAllowedResponse = (): Response =>
  jsonErrorResponse(405, "method_not_allowed", "Method Not Allowed");

/** Resolves a Pages dynamic route parameter into one string. */
export const resolveParam = (value: string | string[] | undefined): string =>
  typeof value === "string" ? value : Array.isArray(value) ? value[0] : "";

/** Converts Zod issues to the public validation issue shape. */
export const zodIssuesToApiIssues = (error: z.ZodError): ApiValidationIssue[] =>
  error.issues.map((issue) => ({
    path: issue.path.filter(
      (part): part is string | number =>
        typeof part === "string" || typeof part === "number",
    ),
    code: issue.code,
    message: issue.message,
  }));

/** Parses a JSON value with a Zod schema or throws a structured API error. */
export const parseWithSchema = <T>(
  schema: z.ZodType<T>,
  value: JsonValue,
  message: string,
): T => {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ApiHttpError({
      status: 400,
      code: "validation_failed",
      message,
      details: zodIssuesToApiIssues(result.error),
    });
  }

  return result.data;
};

/** Reads request text while enforcing a byte limit. */
export const readRequestTextWithLimit = async (
  request: Request,
  maxBytes: number,
): Promise<string> => {
  const contentLength = request.headers.get("Content-Length");
  if (contentLength) {
    const parsedLength = Number.parseInt(contentLength, 10);
    if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
      throw new ApiHttpError({
        status: 413,
        code: "body_too_large",
        message: `Request body exceeds ${maxBytes} bytes.`,
      });
    }
  }

  const text = await request.text();
  if (textEncoder.encode(text).byteLength > maxBytes) {
    throw new ApiHttpError({
      status: 413,
      code: "body_too_large",
      message: `Request body exceeds ${maxBytes} bytes.`,
    });
  }

  return text;
};

/** Reads and validates a JSON request body. */
export const readJsonBodyWithSchema = async <T>(
  request: Request,
  schema: z.ZodType<T>,
  options: {
    maxBytes: number;
    validationMessage: string;
  },
): Promise<T> => {
  const rawBody = await readRequestTextWithLimit(request, options.maxBytes);
  return parseJsonTextWithSchema(rawBody, schema, options.validationMessage);
};

/** Parses JSON text with a Zod schema or throws a structured API error. */
export const parseJsonTextWithSchema = <T>(
  rawBody: string,
  schema: z.ZodType<T>,
  validationMessage: string,
): T => {
  let parsed: JsonValue;

  try {
    parsed = JSON.parse(rawBody) as JsonValue;
  } catch {
    throw new ApiHttpError({
      status: 400,
      code: "invalid_json",
      message: "Invalid JSON payload.",
    });
  }

  return parseWithSchema(schema, parsed, validationMessage);
};

import { z } from "zod";

const textEncoder = new TextEncoder();

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface ApiValidationIssue {
  path: Array<string | number>;
  code: string;
  message: string;
}

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

export const isApiHttpError = (error: unknown): error is ApiHttpError =>
  error instanceof ApiHttpError;

export const jsonResponse = (body: object, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });

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

export const apiHttpErrorResponse = (error: ApiHttpError): Response =>
  jsonErrorResponse(error.status, error.code, error.message, error.details);

export const methodNotAllowedResponse = (): Response =>
  jsonErrorResponse(405, "method_not_allowed", "Method Not Allowed");

export const resolveParam = (value: string | string[] | undefined): string =>
  typeof value === "string" ? value : Array.isArray(value) ? value[0] : "";

export const zodIssuesToApiIssues = (error: z.ZodError): ApiValidationIssue[] =>
  error.issues.map((issue) => ({
    path: issue.path.filter(
      (part): part is string | number =>
        typeof part === "string" || typeof part === "number",
    ),
    code: issue.code,
    message: issue.message,
  }));

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

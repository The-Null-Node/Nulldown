import { NULLDOWN_ACCOUNT_ID_HEADER } from "../../../shared/drop/branch";

const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/;

export const sanitizeAccountId = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed || !ACCOUNT_ID_PATTERN.test(trimmed)) {
    return null;
  }

  return trimmed;
};

export const readRequestAccountId = (request: Request): string | null =>
  sanitizeAccountId(request.headers.get(NULLDOWN_ACCOUNT_ID_HEADER));

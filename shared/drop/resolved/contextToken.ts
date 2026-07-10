import { serializeCanonicalJson } from "../types";
import { NULLDOWN_CONTEXT_TOKEN_PREFIX } from "./constants";
import type { NulldownContextToken } from "./types";
import { isNulldownContextToken } from "./validators";

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const fromBase64Url = (value: string): Uint8Array | null => {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
    return null;
  }

  const padded = `${value.replace(/-/g, "+").replace(/_/g, "/")}${"=".repeat(
    (4 - (value.length % 4)) % 4,
  )}`;
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

export const encodeNulldownContextToken = (
  token: NulldownContextToken,
): string => {
  if (!isNulldownContextToken(token)) {
    throw new Error("Invalid Nulldown context token.");
  }

  const encoded = new TextEncoder().encode(serializeCanonicalJson(token));
  return `${NULLDOWN_CONTEXT_TOKEN_PREFIX}${toBase64Url(encoded)}`;
};

export const decodeNulldownContextToken = (
  value: string,
): NulldownContextToken | null => {
  if (!value.startsWith(NULLDOWN_CONTEXT_TOKEN_PREFIX)) return null;

  const payload = value.slice(NULLDOWN_CONTEXT_TOKEN_PREFIX.length);
  const bytes = fromBase64Url(payload);
  if (!bytes) return null;

  try {
    const decoded = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    return isNulldownContextToken(decoded) ? decoded : null;
  } catch {
    return null;
  }
};

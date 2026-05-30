const textEncoder = new TextEncoder();

/** Reads a bearer token from the request Authorization header. */
export const readBearerToken = (request: Request): string | null => {
  const authorization = request.headers.get("Authorization") || "";
  if (!authorization.startsWith("Bearer ")) {
    return null;
  }

  const token = authorization.slice("Bearer ".length).trim();
  return token || null;
};

/** Compares two strings without early exit on content mismatch. */
export const timingSafeStringEqual = (left: string, right: string): boolean => {
  const leftBytes = textEncoder.encode(left);
  const rightBytes = textEncoder.encode(right);
  const maxLength = Math.max(leftBytes.length, rightBytes.length);

  let diff = leftBytes.length ^ rightBytes.length;

  for (let index = 0; index < maxLength; index += 1) {
    diff |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }

  return diff === 0;
};

/** Verifies the request bearer token against an expected secret. */
export const verifyBearerToken = (
  request: Request,
  expectedToken: string,
): boolean => {
  const token = readBearerToken(request);
  return token !== null && timingSafeStringEqual(token, expectedToken);
};

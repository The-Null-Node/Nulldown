const getRawErrorMessage = (error: unknown): string => {
  if (error instanceof Error && typeof error.message === "string") {
    return error.message.trim();
  }

  if (typeof error === "string") {
    return error.trim();
  }

  return String(error ?? "").trim();
};

const messageIncludes = (message: string, tokens: readonly string[]): boolean => {
  const lower = message.toLowerCase();
  return tokens.some((token) => lower.includes(token));
};

export const toUserFacingDropError = (
  error: unknown,
  fallback = "Something went wrong. Please try again.",
): string => {
  const message = getRawErrorMessage(error);

  if (!message) {
    return fallback;
  }

  if (
    messageIncludes(message, [
      "cannot share empty content",
      "request body cannot be empty",
    ])
  ) {
    return "Add some content before sharing.";
  }

  if (
    messageIncludes(message, [
      "drop not found",
      "failed to resolve drop",
      "could not resolve",
    ])
  ) {
    return "We couldn't find that drop.";
  }

  if (
    messageIncludes(message, [
      "unable to decrypt",
      "provider escrow",
      "different account vault",
      "signature verification failed",
      "operationerror",
    ])
  ) {
    return "This drop is locked to a different account or key on this device.";
  }

  if (
    messageIncludes(message, [
      "failed to publish",
      "failed to store",
      "provider unlock request failed",
      "networkerror",
      "fetch",
    ])
  ) {
    return "We couldn't complete that action right now. Please try again.";
  }

  if (message.length > 220) {
    return fallback;
  }

  return message;
};

export const getDropErrorMessage = getRawErrorMessage;

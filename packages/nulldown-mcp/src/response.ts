/** Text content item returned by Nulldown MCP tools. */
export interface NulldownMcpTextContent {
  /** MCP content item type. */
  type: "text";
  /** Serialized tool response text. */
  text: string;
}

/** Standard Nulldown MCP tool response shape. */
export interface NulldownMcpToolResponse {
  /** MCP content returned to the caller. */
  content: NulldownMcpTextContent[];
}

const DEFAULT_MAX_TOKENS = 800;

/** Serializes a tool value as pretty JSON MCP text content. */
export const asJsonText = (value: unknown): NulldownMcpToolResponse => ({
  content: [
    {
      type: "text",
      text: JSON.stringify(value ?? null, null, 2),
    },
  ],
});

/** Options for compact/preview responses with token cap. */
export interface CompactResponseOptions {
  /** Return compact preview instead of full payload. */
  preview?: boolean;
  /** Hard cap on response tokens (approx). */
  maxTokens?: number;
  /** Response format. */
  format?: "compact" | "full";
}

/** Valid response returned when a requested result exceeds the token budget. */
export interface TruncatedMcpResponse {
  /** Indicates that the original serialized response exceeded the requested budget. */
  truncated: true;
  /** Approximate token budget used for the response. */
  maxTokens: number;
  /** Character length of the complete serialized response. */
  totalChars: number;
  /** Prefix of the complete serialized response for inspection. */
  preview: string;
}

const serialize = (value: unknown, compact: boolean): string =>
  JSON.stringify(value ?? null, null, compact ? 0 : 2);

const truncate = (
  text: string,
  maxTokens: number,
  compact: boolean,
): string => {
  const maxChars = maxTokens * 4;
  const indent = compact ? 0 : 2;
  const serializeEnvelope = (preview: string): string =>
    JSON.stringify(
      {
        truncated: true,
        maxTokens,
        totalChars: text.length,
        preview,
      } satisfies TruncatedMcpResponse,
      null,
      indent,
    );

  let low = 0;
  let high = Math.min(text.length, maxChars);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (serializeEnvelope(text.slice(0, middle)).length <= maxChars) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return serializeEnvelope(text.slice(0, low));
};

/** Serializes value as compact, token-capped MCP text content. */
export const asCompact = (
  value: unknown,
  opts: CompactResponseOptions = {},
): NulldownMcpToolResponse => {
  const max = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const useCompact = opts.preview !== false;
  const fmt = opts.format ?? (useCompact ? "compact" : "full");

  const compact = fmt === "compact";
  const serialized = serialize(value, compact);
  const text =
    serialized.length > max * 4 ? truncate(serialized, max, compact) : serialized;
  return { content: [{ type: "text", text }] };
};

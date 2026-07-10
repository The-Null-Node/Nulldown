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

/** Serializes value as compact, token-capped MCP text content. */
export const asCompact = (
  value: unknown,
  opts: CompactResponseOptions = {},
): NulldownMcpToolResponse => {
  const max = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const useCompact = opts.preview !== false;
  const fmt = opts.format ?? (useCompact ? "compact" : "full");

  let text = JSON.stringify(value ?? null, null, fmt === "compact" ? 0 : 2);
  if (text.length > max * 4) {
    const truncated = text.slice(0, max * 4 - 20) + "... [truncated]";
    text = truncated;
  }
  return { content: [{ type: "text", text }] };
};

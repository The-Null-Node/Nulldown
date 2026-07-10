import { z } from "zod";
import {
  createNulldownClient,
  type CreateNulldownClientOptions,
  type NulldownJsonValue,
} from "../client/nulldownClient";

/** Shared optional client arguments accepted by Nulldown MCP tools. */
export const clientArgsSchema = {
  baseUrl: z
    .string()
    .url()
    .optional()
    .describe("Nulldown API base URL. Defaults to ND_BASE_URL or production."),
  accountId: z
    .string()
    .optional()
    .describe("Optional account id header for local/dev APIs."),
  clientId: z
    .string()
    .optional()
    .describe("Stable diff client id. Defaults to ND_CLIENT_ID when set."),
};

/** Recursive JSON value schema accepted by MCP tool metadata inputs. */
export const jsonValueSchema: z.ZodType<NulldownJsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

/** JSON object schema accepted by MCP metadata inputs. */
export const jsonRecordSchema = z.record(z.string(), jsonValueSchema);

/** Client construction arguments accepted by every Nulldown MCP tool. */
export interface ClientArgs {
  baseUrl?: string;
  accountId?: string;
  clientId?: string;
}

/** Response control flags accepted by MCP tools. */
export interface McpResponseArgs {
  preview?: boolean;
  maxTokens?: number;
  format?: "compact" | "full";
}

export const mcpResponseArgsSchema = {
  preview: z.boolean().optional().describe("Return compact preview (default true)."),
  maxTokens: z.number().int().min(100).max(8000).optional().describe("Hard token cap (default 800)."),
  format: z.enum(["compact", "full"]).optional().describe("Response format."),
};

/** Extracts response control flags from tool args. */
export const extractMcpResponseArgs = (args: Record<string, unknown>): McpResponseArgs => ({
  preview: args.preview as boolean | undefined,
  maxTokens: args.maxTokens as number | undefined,
  format: args.format as "compact" | "full" | undefined,
});

/** Creates a Nulldown API client from MCP tool arguments. */
export const createClient = (args: ClientArgs = {}) => {
  const options: CreateNulldownClientOptions = {
    baseUrl: args.baseUrl,
    accountId: args.accountId,
    clientId: args.clientId,
  };
  return createNulldownClient(options);
};

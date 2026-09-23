import type { JsonValue } from "../nullplug/types";
import type { NullMemSourceRef } from "./source-reference";

/** Runtime call guidance attached to one reusable procedure step. */
export interface NullMemProcedureCallHint {
  target: "tool" | "mcp" | "cli" | "nullplug";
  name: string;
  args?: Record<string, JsonValue>;
  argsSummary?: string;
}

/** One ordered operation in a reusable procedure or reasoning trace. */
export interface NullMemProcedureStep {
  index: number;
  kind:
    | "tool.call"
    | "nullplug.call"
    | "mcp.call"
    | "diff.apply"
    | "query"
    | "deploy"
    | "test"
    | "note";
  name: string;
  description?: string;
  argsSummary?: string;
  callHint?: NullMemProcedureCallHint;
  exitCondition?: string;
  minStep?: boolean;
  resultSummary?: string;
  status: "success" | "failed" | "skipped" | "partial";
  refs?: NullMemSourceRef[];
}

/** Compact next-step projection used to execute procedures atomically. */
export interface NullMemProcedureStepProjection {
  procedureId: string;
  goal: string;
  summary: string;
  step: NullMemProcedureStep;
  nextCursor?: number;
  remainingSteps: number;
}

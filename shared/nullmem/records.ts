import type { JsonValue } from "../nullplug/types";
import type { NullMemProcedureStep } from "./procedure";
import type { NullMemSourceRef } from "./source-reference";

export const NULLMEM_RECORD_VERSION = 1 as const;

/** Example attached to a capability to help agents decide how to use it. */
export interface NullMemCapabilityExample {
  title?: string;
  input?: JsonValue;
  output?: JsonValue;
  summary?: string;
}

/** Queryable capability memory for nullplugs, tools, themes, and MCP tools. */
export interface NullMemCapabilityRecord {
  version: typeof NULLMEM_RECORD_VERSION;
  kind: "capability";
  recordId: string;
  capabilityKind: "nullplug" | "tool" | "theme" | "mcp";
  capabilityId: string;
  capabilityVersion?: string;
  title?: string;
  description: string;
  inputSchema?: JsonValue;
  outputSchema?: JsonValue;
  permissions?: JsonValue[];
  whenToUse?: string[];
  whenNotToUse?: string[];
  examples?: NullMemCapabilityExample[];
  labels?: string[];
  priority?: number;
  confidence?: number;
  sourceRefs?: NullMemSourceRef[];
  createdAt: number;
  updatedAt?: number;
  metadata?: Record<string, JsonValue>;
}

/** Reusable procedure memory that records how a goal was achieved. */
export interface NullMemProcedureRecord {
  version: typeof NULLMEM_RECORD_VERSION;
  kind: "procedure";
  recordId: string;
  rootDropId?: string;
  branchId?: string;
  goal: string;
  summary: string;
  steps: NullMemProcedureStep[];
  outcome: "success" | "partial" | "failed";
  reusableAs?: string;
  labels?: string[];
  priority?: number;
  confidence?: number;
  sourceRefs?: NullMemSourceRef[];
  createdAt: number;
  updatedAt?: number;
  metadata?: Record<string, JsonValue>;
}

/** Branch-scoped memory annotation that does not mutate primary markdown. */
export interface NullMemFactRecord {
  version: typeof NULLMEM_RECORD_VERSION;
  kind: "fact";
  recordId: string;
  rootDropId?: string;
  branchId?: string;
  targetKind?: NullMemSourceRef["kind"] | "custom";
  targetId?: string;
  title?: string;
  text: string;
  labels?: string[];
  priority?: number;
  confidence?: number;
  sourceRefs?: NullMemSourceRef[];
  createdAt: number;
  updatedAt?: number;
  metadata?: Record<string, JsonValue>;
}

/** Any persisted or built-in NullMem record. */
export type NullMemRecord =
  NullMemCapabilityRecord | NullMemProcedureRecord | NullMemFactRecord;

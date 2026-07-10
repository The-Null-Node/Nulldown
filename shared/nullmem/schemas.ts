import { z } from "zod";
import type { JsonValue } from "../nullplug/types";
import {
  NULLMEM_RECORD_VERSION,
  type NullMemCapabilityExample,
  type NullMemCapabilityRecord,
  type NullMemFactRecord,
  type NullMemProcedureCallHint,
  type NullMemProcedureRecord,
  type NullMemProcedureStep,
  type NullMemQuery,
  type NullMemRecord,
} from "./types";
import { NullMemSourceRefSchema } from "./sourceRefs";
export { NullMemSourceRefSchema, isNullMemSourceRef } from "./sourceRefs";

const finiteNumberSchema = z.number().finite();

/** Canonical JSON value schema used by NullMem metadata and capability schemas. */
export const NullMemJsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    finiteNumberSchema,
    z.string(),
    z.array(NullMemJsonValueSchema),
    z.record(z.string(), NullMemJsonValueSchema),
  ]),
);

/** Canonical JSON object schema used by NullMem records. */
export const NullMemJsonRecordSchema = z.record(
  z.string(),
  NullMemJsonValueSchema,
);

const NullMemSourceRefsSchema = z.array(NullMemSourceRefSchema).optional();

/** Canonical schema for compact procedure call hints. */
export const NullMemProcedureCallHintSchema = z.object({
  target: z.enum(["tool", "mcp", "cli", "nullplug"]),
  name: z.string(),
  args: NullMemJsonRecordSchema.optional(),
  argsSummary: z.string().optional(),
}) satisfies z.ZodType<NullMemProcedureCallHint>;

/** Canonical schema for capability usage examples. */
export const NullMemCapabilityExampleSchema = z.object({
  title: z.string().optional(),
  input: NullMemJsonValueSchema.optional(),
  output: NullMemJsonValueSchema.optional(),
  summary: z.string().optional(),
}) satisfies z.ZodType<NullMemCapabilityExample>;

/** Canonical schema for capability memory records. */
export const NullMemCapabilityRecordSchema = z.object({
  version: z.literal(NULLMEM_RECORD_VERSION),
  kind: z.literal("capability"),
  recordId: z.string(),
  capabilityKind: z.enum(["nullplug", "tool", "theme", "mcp"]),
  capabilityId: z.string(),
  capabilityVersion: z.string().optional(),
  title: z.string().optional(),
  description: z.string(),
  inputSchema: NullMemJsonValueSchema.optional(),
  outputSchema: NullMemJsonValueSchema.optional(),
  permissions: z.array(NullMemJsonValueSchema).optional(),
  whenToUse: z.array(z.string()).optional(),
  whenNotToUse: z.array(z.string()).optional(),
  examples: z.array(NullMemCapabilityExampleSchema).optional(),
  labels: z.array(z.string()).optional(),
  priority: finiteNumberSchema.optional(),
  confidence: finiteNumberSchema.optional(),
  sourceRefs: NullMemSourceRefsSchema,
  createdAt: finiteNumberSchema,
  updatedAt: finiteNumberSchema.optional(),
  metadata: NullMemJsonRecordSchema.optional(),
}) satisfies z.ZodType<NullMemCapabilityRecord>;

/** Returns true when a value is a valid NullMem capability record. */
export const isNullMemCapabilityRecord = (
  value: unknown,
): value is NullMemCapabilityRecord =>
  NullMemCapabilityRecordSchema.safeParse(value).success;

/** Canonical schema for reusable procedure steps. */
export const NullMemProcedureStepSchema = z.object({
  index: finiteNumberSchema,
  kind: z.enum([
    "tool.call",
    "nullplug.call",
    "mcp.call",
    "diff.apply",
    "query",
    "deploy",
    "test",
    "note",
  ]),
  name: z.string(),
  description: z.string().optional(),
  argsSummary: z.string().optional(),
  callHint: NullMemProcedureCallHintSchema.optional(),
  exitCondition: z.string().optional(),
  minStep: z.boolean().optional(),
  resultSummary: z.string().optional(),
  status: z.enum(["success", "failed", "skipped", "partial"]),
  refs: NullMemSourceRefsSchema,
}) satisfies z.ZodType<NullMemProcedureStep>;

/** Canonical schema for reusable procedure memory records. */
export const NullMemProcedureRecordSchema = z.object({
  version: z.literal(NULLMEM_RECORD_VERSION),
  kind: z.literal("procedure"),
  recordId: z.string(),
  rootDropId: z.string().optional(),
  branchId: z.string().optional(),
  goal: z.string(),
  summary: z.string(),
  steps: z.array(NullMemProcedureStepSchema),
  outcome: z.enum(["success", "partial", "failed"]),
  reusableAs: z.string().optional(),
  labels: z.array(z.string()).optional(),
  priority: finiteNumberSchema.optional(),
  confidence: finiteNumberSchema.optional(),
  sourceRefs: NullMemSourceRefsSchema,
  createdAt: finiteNumberSchema,
  updatedAt: finiteNumberSchema.optional(),
  metadata: NullMemJsonRecordSchema.optional(),
}) satisfies z.ZodType<NullMemProcedureRecord>;

/** Returns true when a value is a valid NullMem procedure record. */
export const isNullMemProcedureRecord = (
  value: unknown,
): value is NullMemProcedureRecord =>
  NullMemProcedureRecordSchema.safeParse(value).success;

/** Canonical schema for branch-scoped fact memory records. */
export const NullMemFactRecordSchema = z.object({
  version: z.literal(NULLMEM_RECORD_VERSION),
  kind: z.literal("fact"),
  recordId: z.string(),
  rootDropId: z.string().optional(),
  branchId: z.string().optional(),
  targetKind: z
    .enum([
      "drop",
      "branch",
      "snapshot",
      "diff",
      "node",
      "heap",
      "nullplug",
      "tool",
      "theme",
      "mcp",
      "custom",
    ])
    .optional(),
  targetId: z.string().optional(),
  title: z.string().optional(),
  text: z.string(),
  labels: z.array(z.string()).optional(),
  priority: finiteNumberSchema.optional(),
  confidence: finiteNumberSchema.optional(),
  sourceRefs: NullMemSourceRefsSchema,
  createdAt: finiteNumberSchema,
  updatedAt: finiteNumberSchema.optional(),
  metadata: NullMemJsonRecordSchema.optional(),
}) satisfies z.ZodType<NullMemFactRecord>;

/** Returns true when a value is a valid NullMem fact record. */
export const isNullMemFactRecord = (
  value: unknown,
): value is NullMemFactRecord =>
  NullMemFactRecordSchema.safeParse(value).success;

/** Canonical schema for any persisted or built-in NullMem record. */
export const NullMemRecordSchema = z.discriminatedUnion("kind", [
  NullMemCapabilityRecordSchema,
  NullMemProcedureRecordSchema,
  NullMemFactRecordSchema,
]) satisfies z.ZodType<NullMemRecord>;

/** Canonical schema for querying NullMem capsules. */
export const NullMemQuerySchema = z.object({
  q: z.string().optional(),
  kind: z.enum(["capability", "procedure", "fact"]).optional(),
  labels: z.array(z.string()).optional(),
  limit: finiteNumberSchema.optional(),
  procedureId: z.string().optional(),
  afterStep: finiteNumberSchema.optional(),
  stepLimit: finiteNumberSchema.optional(),
}) satisfies z.ZodType<NullMemQuery>;

/** Returns true when a value is any valid NullMem record. */
export const isNullMemRecord = (value: unknown): value is NullMemRecord =>
  NullMemRecordSchema.safeParse(value).success;

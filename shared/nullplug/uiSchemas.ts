import { z } from "zod";
import { DropDiffEnvelopeSchema } from "../drop/diffSchemas";
import type { DropDiffEnvelope } from "../drop/diff";
import type { JsonValue } from "./types";
import type {
  NullplugActionPrimitive,
  NullplugCardPrimitive,
  NullplugFormPrimitive,
  NullplugUiField,
  NullplugUiFieldOption,
  NullplugUiPrimitive,
  NullplugUiResponseFact,
  NullplugUiSource,
  NullplugUiStatePatchFact,
  NullplugUiStatePatchOperation,
  NullplugUiStateSnapshot,
} from "./ui";

const finiteNumberSchema = z.number().finite();

export const NullplugUiJsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    finiteNumberSchema,
    z.string(),
    z.array(NullplugUiJsonValueSchema),
    z.record(z.string(), NullplugUiJsonValueSchema),
  ]),
);

export const NullplugUiJsonRecordSchema = z.record(
  z.string(),
  NullplugUiJsonValueSchema,
);

export const NullplugUiSourceSchema = z.object({
  rootDropId: z.string(),
  branchId: z.string().optional(),
  snapshotId: finiteNumberSchema.optional(),
  eventId: z.string().optional(),
  callId: z.string().optional(),
}) satisfies z.ZodType<NullplugUiSource>;

export const NullplugUiFieldOptionSchema = z.object({
  label: z.string(),
  value: NullplugUiJsonValueSchema,
}) satisfies z.ZodType<NullplugUiFieldOption>;

export const NullplugUiFieldSchema = z.object({
  name: z.string(),
  type: z.enum(["text", "textarea", "number", "boolean", "select"]),
  label: z.string().optional(),
  required: z.boolean().optional(),
  defaultValue: NullplugUiJsonValueSchema.optional(),
  options: z.array(NullplugUiFieldOptionSchema).optional(),
  metadata: NullplugUiJsonRecordSchema.optional(),
}) satisfies z.ZodType<NullplugUiField>;

const primitiveFields = {
  source: NullplugUiSourceSchema.optional(),
  metadata: NullplugUiJsonRecordSchema.optional(),
};

export const NullplugActionPrimitiveSchema = z.object({
  kind: z.literal("action"),
  id: z.string(),
  label: z.string(),
  intent: z.string().optional(),
  value: NullplugUiJsonValueSchema.optional(),
  requiresConfirmation: z.boolean().optional(),
  ...primitiveFields,
}) satisfies z.ZodType<NullplugActionPrimitive>;

export const NullplugFormPrimitiveSchema = z.object({
  kind: z.literal("form"),
  id: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  fields: z.array(NullplugUiFieldSchema),
  submitLabel: z.string().optional(),
  ...primitiveFields,
}) satisfies z.ZodType<NullplugFormPrimitive>;

export const NullplugCardPrimitiveSchema = z.object({
  kind: z.literal("card"),
  id: z.string(),
  title: z.string().optional(),
  body: z.string().optional(),
  actions: z.array(NullplugActionPrimitiveSchema).optional(),
  ...primitiveFields,
}) satisfies z.ZodType<NullplugCardPrimitive>;

export const NullplugUiPrimitiveSchema = z.discriminatedUnion("kind", [
  NullplugFormPrimitiveSchema,
  NullplugActionPrimitiveSchema,
  NullplugCardPrimitiveSchema,
]) satisfies z.ZodType<NullplugUiPrimitive>;

export const NullplugUiStatePatchOperationSchema = z.discriminatedUnion("op", [
    z.object({
      op: z.literal("set"),
      path: z.array(z.string().trim().min(1)).min(1),
      value: NullplugUiJsonValueSchema,
    }),
    z.object({
      op: z.literal("delete"),
      path: z.array(z.string().trim().min(1)).min(1),
      value: z.undefined().optional(),
    }),
  ]) satisfies z.ZodType<NullplugUiStatePatchOperation>;

export const NullplugUiResponseFactSchema = z.object({
  version: z.literal(1),
  kind: z.literal("ui.response"),
  id: z.string(),
  primitiveId: z.string(),
  createdAt: finiteNumberSchema,
  source: NullplugUiSourceSchema,
  data: NullplugUiJsonRecordSchema,
  proposedDiffs: DropDiffEnvelopeSchema.optional() as z.ZodOptional<
    z.ZodType<DropDiffEnvelope>
  >,
  metadata: NullplugUiJsonRecordSchema.optional(),
}) satisfies z.ZodType<NullplugUiResponseFact>;

export const NullplugUiStatePatchFactSchema = z.object({
  version: z.literal(1),
  kind: z.literal("ui.state.patch"),
  id: z.string(),
  callId: z.string(),
  createdAt: finiteNumberSchema,
  source: NullplugUiSourceSchema,
  patch: z.array(NullplugUiStatePatchOperationSchema).min(1),
  reason: z.string().optional(),
  metadata: NullplugUiJsonRecordSchema.optional(),
}) satisfies z.ZodType<NullplugUiStatePatchFact>;

export const NullplugUiStateSnapshotSchema = z.object({
  version: z.literal(1),
  kind: z.literal("ui.state.snapshot"),
  id: z.string(),
  callId: z.string(),
  createdAt: finiteNumberSchema,
  source: NullplugUiSourceSchema,
  state: NullplugUiJsonRecordSchema,
  patchIds: z.array(z.string()).optional(),
  metadata: NullplugUiJsonRecordSchema.optional(),
}) satisfies z.ZodType<NullplugUiStateSnapshot>;

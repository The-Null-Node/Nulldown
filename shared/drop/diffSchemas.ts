import { z } from "zod";
import { DiffOp } from "../nulledit/types";
import type {
  DropDiffEnvelope,
  DropDiffEvent,
  DropDiffEventMetadata,
  DropDiffNativeOp,
  DropDiffOp,
  JsonValue,
} from "./diff";

export const DIFF_ENVELOPE_MAX_EVENTS = 100;
export const DIFF_EVENT_MAX_OPS = 1000;
export const DIFF_TOKEN_MAX_LENGTH = 120;
export const DIFF_TEXT_MAX_LENGTH = 1_000_000;
export const DIFF_NATIVE_DATA_MAX_LENGTH = 1_500_000;
export const DIFF_METADATA_STRING_MAX_LENGTH = 10_000;
export const DIFF_METADATA_MAX_LABELS = 32;
export const DIFF_METADATA_MAX_ARRAY_LENGTH = 200;
export const DIFF_METADATA_MAX_KEYS = 200;
export const DIFF_METADATA_KEY_MAX_LENGTH = 120;

const finiteNumberSchema = z.number().finite();
const sequenceNumberSchema = finiteNumberSchema.int().min(-1);
const tokenSchema = z.string().trim().min(1).max(DIFF_TOKEN_MAX_LENGTH);
const metadataStringSchema = z.string().max(DIFF_METADATA_STRING_MAX_LENGTH);
const base64Schema = z
  .string()
  .min(1)
  .max(DIFF_NATIVE_DATA_MAX_LENGTH)
  .regex(/^[A-Za-z0-9+/]*={0,2}$/, "Expected base64-encoded data.")
  .refine((value) => value.length % 4 === 0, {
    message: "Expected padded base64 data.",
  });

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    finiteNumberSchema,
    metadataStringSchema,
    z.array(JsonValueSchema).max(DIFF_METADATA_MAX_ARRAY_LENGTH),
    z
      .record(
        z.string().min(1).max(DIFF_METADATA_KEY_MAX_LENGTH),
        JsonValueSchema,
      )
      .refine((value) => Object.keys(value).length <= DIFF_METADATA_MAX_KEYS, {
        message: `Metadata objects may include at most ${DIFF_METADATA_MAX_KEYS} keys.`,
      }),
  ]),
);

export const DiffRangeSchema = z
  .object({
    start: finiteNumberSchema.int().min(0),
    end: finiteNumberSchema.int().min(0),
  })
  .strict()
  .refine((value) => value.end >= value.start, {
    path: ["end"],
    message: "Range end must be greater than or equal to start.",
  });

export const DropDiffNativeOpSchema = z
  .object({
    op: z.union([
      z.literal(DiffOp.INSERT),
      z.literal(DiffOp.DELETE),
      z.literal(DiffOp.RETAIN),
    ]),
    data: base64Schema,
    range: DiffRangeSchema.optional(),
  })
  .strict() satisfies z.ZodType<DropDiffNativeOp>;

export const DropDiffOpSchema = z
  .object({
    type: z.enum(["insert", "delete"]).optional(),
    start: finiteNumberSchema.int().min(0).optional(),
    end: finiteNumberSchema.int().min(0).optional(),
    text: z.string().max(DIFF_TEXT_MAX_LENGTH).optional(),
    native: DropDiffNativeOpSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const legacyStart = value.start;
    const legacyEnd = value.end;
    const hasLegacy =
      value.type !== undefined &&
      legacyStart !== undefined &&
      legacyEnd !== undefined &&
      value.text !== undefined;

    if (hasLegacy && legacyEnd < legacyStart) {
      context.addIssue({
        code: "custom",
        path: ["end"],
        message: "Legacy diff end must be greater than or equal to start.",
      });
    }

    if (!hasLegacy && !value.native) {
      context.addIssue({
        code: "custom",
        message: "Diff op must include either a complete legacy op or native op.",
      });
    }
  }) satisfies z.ZodType<DropDiffOp>;

export const DropDiffEventMetadataSchema = z
  .object({
    kind: z
      .enum([
        "user.edit",
        "agent.edit",
        "nullplug.invoke",
        "nullplug.result",
        "ui.response",
        "policy.decision",
      ])
      .optional(),
    intent: metadataStringSchema.optional(),
    pluginId: tokenSchema.optional(),
    args: z
      .record(
        z.string().min(1).max(DIFF_METADATA_KEY_MAX_LENGTH),
        JsonValueSchema,
      )
      .refine((value) => Object.keys(value).length <= DIFF_METADATA_MAX_KEYS, {
        message: `Metadata args may include at most ${DIFF_METADATA_MAX_KEYS} keys.`,
      })
      .optional(),
    batchId: tokenSchema.optional(),
    batchIndex: finiteNumberSchema.int().min(0).optional(),
    parentEventId: tokenSchema.optional(),
    followsSeq: sequenceNumberSchema.optional(),
    labels: z.array(tokenSchema).max(DIFF_METADATA_MAX_LABELS).optional(),
    confidence: finiteNumberSchema.min(0).max(1).optional(),
    resultRef: tokenSchema.optional(),
    policyDecisionRef: tokenSchema.optional(),
  })
  .strict() satisfies z.ZodType<DropDiffEventMetadata>;

export const DropDiffEventSchema = z
  .object({
    eventId: tokenSchema,
    seq: sequenceNumberSchema,
    dropId: tokenSchema,
    sourceClientId: tokenSchema,
    createdAt: finiteNumberSchema.int().min(0),
    snapshotId: finiteNumberSchema.int().min(0).optional(),
    ops: z.array(DropDiffOpSchema).min(1).max(DIFF_EVENT_MAX_OPS),
    metadata: DropDiffEventMetadataSchema.optional(),
  })
  .strict() satisfies z.ZodType<DropDiffEvent>;

export const DropDiffEnvelopeSchema = z
  .object({
    version: z.literal(1),
    events: z.array(DropDiffEventSchema).max(DIFF_ENVELOPE_MAX_EVENTS),
  })
  .strict() satisfies z.ZodType<DropDiffEnvelope>;

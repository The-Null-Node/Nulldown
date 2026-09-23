import { z } from "zod";
import { DiffOp, type Diff } from "../../nulledit/types";
import { decodeText, encodeText } from "../../nulledit/textDiff";
import type {
  DropBranchRuntimeFact,
  DropDiffEnvelope,
  DropDiffEvent,
  DropDiffEventMetadata,
  DropDiffNativeOp,
  DropDiffOp,
  JsonValue,
} from "../diff";

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
// Zod's `.int()` also rejects unsafe integers. Persisted diff history must remain
// readable, so append-only safe-integer enforcement lives in the schema below.
const integerSchema = finiteNumberSchema.refine(Number.isInteger, {
  message: "Expected an integer.",
});
const sequenceNumberSchema = integerSchema.min(-1);
const tokenSchema = z.string().trim().min(1).max(DIFF_TOKEN_MAX_LENGTH);
/** Stable event identifier accepted by durable diff retry surfaces. */
export const DropDiffEventIdSchema = z
  .string()
  .min(1)
  .max(DIFF_TOKEN_MAX_LENGTH)
  .refine((value) => value.trim() === value, {
    message: "Event id must not include surrounding whitespace.",
  });
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
    start: integerSchema.min(0),
    end: integerSchema.min(0),
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
    start: integerSchema.min(0).optional(),
    end: integerSchema.min(0).optional(),
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
        message:
          "Diff op must include either a complete legacy op or native op.",
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
    batchIndex: integerSchema.min(0).optional(),
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
    eventId: DropDiffEventIdSchema,
    seq: sequenceNumberSchema,
    dropId: tokenSchema,
    sourceClientId: tokenSchema,
    createdAt: integerSchema.min(0),
    snapshotId: integerSchema.min(0).optional(),
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

const requireSafeInteger = (
  value: number,
  path: (string | number)[],
  context: z.RefinementCtx,
): void => {
  if (!Number.isSafeInteger(value)) {
    context.addIssue({
      code: "custom",
      path,
      message: "Expected a safe integer.",
    });
  }
};

/**
 * Validates new append requests without changing the permissive persisted-event reader.
 *
 * Older branch history may contain finite integers outside JavaScript's safe range, so
 * `DropDiffEnvelopeSchema` remains the compatibility reader for stored data and polls.
 */
export const DropDiffAppendEnvelopeSchema = DropDiffEnvelopeSchema.superRefine(
  (envelope, context) => {
    envelope.events.forEach((event, eventIndex) => {
      requireSafeInteger(event.seq, ["events", eventIndex, "seq"], context);
      requireSafeInteger(
        event.createdAt,
        ["events", eventIndex, "createdAt"],
        context,
      );
      if (event.snapshotId !== undefined) {
        requireSafeInteger(
          event.snapshotId,
          ["events", eventIndex, "snapshotId"],
          context,
        );
      }
      if (event.metadata?.batchIndex !== undefined) {
        requireSafeInteger(
          event.metadata.batchIndex,
          ["events", eventIndex, "metadata", "batchIndex"],
          context,
        );
      }
      if (event.metadata?.followsSeq !== undefined) {
        requireSafeInteger(
          event.metadata.followsSeq,
          ["events", eventIndex, "metadata", "followsSeq"],
          context,
        );
      }
      event.ops.forEach((operation, operationIndex) => {
        if (operation.start !== undefined) {
          requireSafeInteger(
            operation.start,
            ["events", eventIndex, "ops", operationIndex, "start"],
            context,
          );
        }
        if (operation.end !== undefined) {
          requireSafeInteger(
            operation.end,
            ["events", eventIndex, "ops", operationIndex, "end"],
            context,
          );
        }
        if (operation.native?.range) {
          requireSafeInteger(
            operation.native.range.start,
            ["events", eventIndex, "ops", operationIndex, "native", "range", "start"],
            context,
          );
          requireSafeInteger(
            operation.native.range.end,
            ["events", eventIndex, "ops", operationIndex, "native", "range", "end"],
            context,
          );
        }
      });
    });
  },
);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isString = (value: unknown): value is string => typeof value === "string";

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

export const isDropBranchRuntimeFactV1 = (
  value: unknown,
  isRuntimeFact: (fact: unknown) => fact is DropBranchRuntimeFact["fact"],
): value is DropBranchRuntimeFact => {
  if (!isRecord(value)) return false;
  if (value.version !== 1) return false;
  if (!isString(value.rootDropId) || !isString(value.branchId)) return false;
  if (
    typeof value.seq !== "number" ||
    !Number.isInteger(value.seq) ||
    value.seq < 0
  )
    return false;
  if (!isString(value.factId) || !isNumber(value.createdAt)) return false;
  if (!isRuntimeFact(value.fact)) return false;

  return (
    value.fact.source.rootDropId === value.rootDropId &&
    value.fact.source.branchId === value.branchId
  );
};

export const isDropDiffEventMetadataV1 = (
  value: unknown,
): value is DropDiffEventMetadata =>
  DropDiffEventMetadataSchema.safeParse(value).success;

const toBase64 = (value: ArrayBuffer): string => {
  const bytes = new Uint8Array(value);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
};

const fromBase64 = (value: string): ArrayBuffer => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
};

export const isDropDiffOpV1 = (value: unknown): value is DropDiffOp =>
  DropDiffOpSchema.safeParse(value).success;

export const isDropDiffEventV1 = (value: unknown): value is DropDiffEvent =>
  DropDiffEventSchema.safeParse(value).success;

export const isDropDiffEnvelopeV1 = (
  value: unknown,
): value is DropDiffEnvelope => DropDiffEnvelopeSchema.safeParse(value).success;

export const diffToDropDiffOpV1 = (diff: Diff): DropDiffOp => {
  const range = diff.range ?? { start: 0, end: 0 };
  const text = decodeText(diff.data);

  // Keep the legacy text form populated so older readers and debugging tools stay useful.
  return {
    type: diff.op === DiffOp.DELETE ? "delete" : "insert",
    start: range.start,
    end: range.end,
    text,
    native: {
      op: diff.op,
      data: toBase64(diff.data),
      range,
    },
  };
};

export const dropDiffOpV1ToDiff = (op: DropDiffOp): Diff | null => {
  if (op.native) {
    // Native ops are authoritative because they preserve the editor's original byte payload.
    const range = op.native.range ?? { start: 0, end: 0 };
    return {
      op: op.native.op,
      data: fromBase64(op.native.data),
      range,
    };
  }

  if (
    (op.type === "insert" || op.type === "delete") &&
    typeof op.start === "number" &&
    typeof op.end === "number" &&
    typeof op.text === "string"
  ) {
    return {
      op: op.type === "insert" ? DiffOp.INSERT : DiffOp.DELETE,
      data: encodeText(op.text),
      range: {
        start: op.start,
        end: op.end,
      },
    };
  }

  return null;
};

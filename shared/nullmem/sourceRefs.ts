import { z } from "zod";
import type { NullMemSourceRef } from "./types";

const finiteNumberSchema = z.number().finite();

/** Canonical schema for source references attached to NullMem records. */
export const NullMemSourceRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("drop"), rootDropId: z.string() }),
  z.object({
    kind: z.literal("branch"),
    rootDropId: z.string(),
    branchId: z.string(),
  }),
  z.object({
    kind: z.literal("snapshot"),
    rootDropId: z.string(),
    branchId: z.string(),
    snapshotId: finiteNumberSchema,
  }),
  z.object({
    kind: z.literal("diff"),
    rootDropId: z.string(),
    branchId: z.string(),
    eventId: z.string(),
    seq: finiteNumberSchema.optional(),
  }),
  z.object({
    kind: z.literal("node"),
    rootDropId: z.string(),
    branchId: z.string(),
    resolverId: z.string(),
    nodeId: z.string(),
  }),
  z.object({
    kind: z.literal("heap"),
    rootDropId: z.string(),
    branchId: z.string(),
    resolverId: z.string(),
    snapshotId: finiteNumberSchema,
  }),
  z.object({
    kind: z.literal("nullplug"),
    pluginId: z.string(),
    version: z.string().optional(),
  }),
  z.object({ kind: z.literal("tool"), toolId: z.string() }),
  z.object({ kind: z.literal("theme"), themeId: z.string() }),
  z.object({ kind: z.literal("mcp"), toolId: z.string() }),
]) satisfies z.ZodType<NullMemSourceRef>;

/** Returns true when a value is a valid NullMem source reference. */
export const isNullMemSourceRef = (value: unknown): value is NullMemSourceRef =>
  NullMemSourceRefSchema.safeParse(value).success;

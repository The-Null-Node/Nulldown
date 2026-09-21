import { z } from "zod";

/** Stable source reference used by NullMem records to cite primary evidence. */
export type NullMemSourceRef =
  | { kind: "drop"; rootDropId: string }
  | { kind: "branch"; rootDropId: string; branchId: string }
  | {
      kind: "snapshot";
      rootDropId: string;
      branchId: string;
      snapshotId: number;
    }
  | {
      kind: "diff";
      rootDropId: string;
      branchId: string;
      eventId: string;
      seq?: number;
    }
  | {
      kind: "node";
      rootDropId: string;
      branchId: string;
      resolverId: string;
      nodeId: string;
    }
  | {
      kind: "heap";
      rootDropId: string;
      branchId: string;
      resolverId: string;
      snapshotId: number;
    }
  | { kind: "nullplug"; pluginId: string; version?: string }
  | { kind: "tool"; toolId: string }
  | { kind: "theme"; themeId: string }
  | { kind: "mcp"; toolId: string };

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

import { z } from "zod";
import type { NullMemRecord } from "./records";

/** Query shape for retrieving mixed NullMem capsules. */
export interface NullMemQuery {
  q?: string;
  kind?: NullMemRecord["kind"];
  labels?: string[];
  limit?: number;
  procedureId?: string;
  afterStep?: number;
  stepLimit?: number;
}

/** Canonical schema for querying NullMem records and procedure projections. */
export const NullMemQuerySchema = z.object({
  q: z.string().optional(),
  kind: z.enum(["capability", "procedure", "fact"]).optional(),
  labels: z.array(z.string()).optional(),
  limit: z.number().finite().optional(),
  procedureId: z.string().optional(),
  afterStep: z.number().finite().optional(),
  stepLimit: z.number().finite().optional(),
}) satisfies z.ZodType<NullMemQuery>;

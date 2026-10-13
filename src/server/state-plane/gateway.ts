import type { BranchStatePlane } from "./contracts";
import type { BranchMemoryStatePlane } from "./contracts";
import type { BranchMemoryService } from "../runtime";
import { createLegacyMemoryStatePlane } from "./legacy-memory";
import type { BranchDiffCommands } from "./contracts";
import { createLegacyBranchDiffCommands } from "./legacy-diffs";
import {
  createLegacyBranchStatePlane,
  type LegacyBranchStatePlaneOptions,
} from "./legacy";

/** Creates a request-scoped branch boundary; legacy is the sole current backend. */
export const createBranchStatePlane = (
  options: LegacyBranchStatePlaneOptions,
): BranchStatePlane => createLegacyBranchStatePlane(options);

/** Routes authorized append commands through an injected request-lifetime legacy service. */
export const createDiffCommandStatePlane = (
  commands: BranchDiffCommands,
): BranchDiffCommands => createLegacyBranchDiffCommands(commands);

/** Routes request-scoped memory behavior through the existing injected application service. */
export const createMemoryStatePlane = (
  memory: BranchMemoryService,
): BranchMemoryStatePlane => createLegacyMemoryStatePlane(memory);

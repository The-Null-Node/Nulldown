import type { BranchStatePlane } from "./contracts";
import {
  createCommitApplicationStatePlane,
  type LocalBranchApplicationSelection,
} from "./commit-application";
import {
  BranchStateError,
  type BranchCommitStatePlane,
} from "../../../shared/drop/branch-state";
import type { BranchMemoryStatePlane } from "./contracts";
import type { BranchMemoryService } from "../runtime";
import { createLegacyMemoryStatePlane } from "./legacy-memory";
import type { BranchDiffCommands } from "./contracts";
import { createLegacyBranchDiffCommands } from "./legacy-diffs";
import {
  createLegacyBranchStatePlane,
  type LegacyBranchStatePlaneOptions,
} from "./legacy";

/** Creates a request-scoped branch boundary with explicit in-process local selection. */
export const createBranchStatePlane = (
  options: LegacyBranchStatePlaneOptions & {
    localBranchApplication?: LocalBranchApplicationSelection;
  },
): BranchStatePlane =>
  options.localBranchApplication
    ? createCommitApplicationStatePlane(options.localBranchApplication)
    : createLegacyBranchStatePlane(options);

/** Routes authorized append commands through the selected request-lifetime application service. */
export const createDiffCommandStatePlane = (
  commands: BranchDiffCommands,
): BranchDiffCommands => createLegacyBranchDiffCommands(commands);

/** Routes request-scoped memory behavior through the existing injected application service. */
export const createMemoryStatePlane = (
  memory: BranchMemoryService,
): BranchMemoryStatePlane => createLegacyMemoryStatePlane(memory);

/** Explicit in-process local opt-in; no environment variable, request header or production placement selects it. */
export interface LocalBranchStatePlaneSelection {
  mode: "local-test";
  commits: BranchCommitStatePlane;
}

/**
 * Selects only the four local transactional capabilities. Existing HTTP/MCP/CLI
 * composition continues through the legacy factories above. Unsupported calls
 * cannot cross back into legacy authority; adapters must reject rather than fall back.
 */
export const createLocalBranchStatePlane = (
  selection: LocalBranchStatePlaneSelection,
): BranchCommitStatePlane => {
  if (selection.mode !== "local-test") {
    throw new BranchStateError("capability_unsupported");
  }
  const { commits } = selection;
  return {
    append: (command) => commits.append(command),
    readHead: (query) => commits.readHead(query),
    readContent: (query) => commits.readContent(query),
    readEvents: (query) => commits.readEvents(query),
  };
};

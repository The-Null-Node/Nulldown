import type { BranchStatePlane } from "./contracts";
import {
  createCommitApplicationStatePlane,
  type LocalBranchApplicationSelection,
} from "./commit-application";
import {
  BranchStateError,
  BranchStateQuery,
  type BranchStateTarget,
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
import {
  captureAuthoritySelection,
  type BranchAuthorityClient,
  type BranchAuthoritySelection,
} from "./authority-control";
import {
  createLegacySourceWriter,
  type SourceWriterEvent,
} from "./legacy-source-writer";

/**
 * Resolves one explicitly enrolled target before composing its application request.
 * A selection never authorizes a write: the source writer obtains a fresh durable
 * permit and the destination enforces placement at each operation boundary.
 */
export async function selectBranchApplication(options: {
  target: BranchStateTarget;
  authority: BranchAuthorityClient;
  destination(
    selection: BranchAuthoritySelection,
  ): LocalBranchApplicationSelection;
  observeWriter?: (event: SourceWriterEvent) => void | Promise<void>;
}) {
  const target = BranchStateQuery.head({
    target: options.target,
    placement: { routingVersion: 1, generation: 0 },
  }).target;
  const selection = captureAuthoritySelection(
    await options.authority.select(target),
    target,
  );
  if (selection.backend === "transition")
    throw new BranchStateError("branch_initialization_pending");
  const legacySourceWriter =
    selection.backend === "legacy"
      ? createLegacySourceWriter({
          target,
          generation: selection.placement.generation,
          admission: options.authority,
          observe: options.observeWriter,
        })
      : undefined;
  return {
    selection,
    legacySourceWriter,
    localBranchApplication:
      selection.backend === "state-plane"
        ? options.destination(selection)
        : undefined,
    /** Discards a legacy read whose authority changed while storage or authorization was awaited. */
    async validateRead(): Promise<void> {
      if (selection.backend !== "legacy") return;
      const current = captureAuthoritySelection(
        await options.authority.select(target),
        target,
      );
      if (
        current.backend !== "legacy" ||
        current.placement.generation !== selection.placement.generation
      )
        throw new BranchStateError("routing_placement_mismatch");
    },
  };
}

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

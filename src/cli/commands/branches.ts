import { flagString, hasFlag, type ParsedArgs } from "../core/args";
import type { CliCommand } from "../core/command";
import type { NulldownRuntime, PriorityTargetKind } from "../runtime/types";

const parseLabels = (args: ParsedArgs): string[] | undefined =>
  flagString(args, "labels")
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

const parseNumberFlag = (args: ParsedArgs, name: string): number | undefined => {
  const value = flagString(args, name);
  return value ? Number.parseFloat(value) : undefined;
};

const parsePriorityTargetKind = (value: string): PriorityTargetKind | null =>
  value === "node" || value === "heap" || value === "diff" ? value : null;

/** Dependencies used by modular branch commands. */
export interface BranchCommandDependencies {
  /** Runtime facade for branch operations. */
  runtime: NulldownRuntime;
  /** Prints command output using the active CLI output policy. */
  print(value: unknown, human?: string): void;
  /** Parses optional metadata flags using the active CLI input policy. */
  parseMetadata(args: ParsedArgs): Promise<Record<string, unknown> | undefined>;
  /** Parses loose JSON values for procedure steps. */
  parseJsonLoose(text: string): unknown | null;
  /** Default resolver id used for node priority targets. */
  defaultDocumentResolverId: string;
}

/** Creates the modular branch command for migrated branch subcommands. */
export const createBranchCommand = <TConfig>(
  dependencies: BranchCommandDependencies,
): CliCommand<TConfig> => ({
  name: "branch",
  async run({ args }) {
    const subcommand = args.positionals[1];

    if (subcommand === "list") {
      const rootId = args.positionals[2];
      if (!rootId) throw new Error("Usage: nd branch list <rootId>");
      const response = await dependencies.runtime.branches.list(rootId);
      dependencies.print(response);
      return;
    }

    if (subcommand === "resolve") {
      const dropId =
        args.positionals[2] || flagString(args, "drop") || flagString(args, "id");
      if (!dropId) throw new Error("Usage: nd branch resolve <dropId>");
      const response = await dependencies.runtime.branches.resolve(dropId);
      dependencies.print(response);
      return;
    }

    if (subcommand === "content") {
      const rootId =
        args.positionals[2] || flagString(args, "drop") || flagString(args, "id");
      const branchId = args.positionals[3] || flagString(args, "branch");
      if (!rootId || !branchId) {
        throw new Error("Usage: nd branch content <rootId> <branchId>");
      }
      const response = await dependencies.runtime.branches.content(rootId, branchId);
      const content =
        response && typeof response === "object" && "content" in response
          ? (response as { content?: string }).content
          : undefined;
      dependencies.print(response, content);
      return;
    }

    if (subcommand === "snapshots") {
      const rootId = args.positionals[2];
      const branchId = args.positionals[3] || flagString(args, "branch");
      if (!rootId || !branchId) {
        throw new Error("Usage: nd branch snapshots <rootId> <branchId>");
      }
      const response = await dependencies.runtime.branches.snapshots(rootId, branchId);
      dependencies.print(response);
      return;
    }

    if (subcommand === "query") {
      const rootId =
        args.positionals[2] || flagString(args, "drop") || flagString(args, "id");
      const branchId = args.positionals[3] || flagString(args, "branch");
      if (!rootId || !branchId) {
        throw new Error("Usage: nd branch query <rootId> <branchId>");
      }
      const response = await dependencies.runtime.resolved.query({
        rootId,
        branchId,
        query: flagString(args, "query") || flagString(args, "q"),
        top: flagString(args, "top") || flagString(args, "k"),
        snapshotId: flagString(args, "snapshot") || flagString(args, "snapshotId"),
        resolverId: flagString(args, "resolver") || flagString(args, "resolverId"),
        kind: flagString(args, "kind"),
        fromSeq: flagString(args, "from-seq") || flagString(args, "fromSeq"),
        toSeq: flagString(args, "to-seq") || flagString(args, "toSeq"),
        pluginId: flagString(args, "plugin") || flagString(args, "pluginId"),
        callId: flagString(args, "call") || flagString(args, "callId"),
        primitiveId: flagString(args, "primitive") || flagString(args, "primitiveId"),
        changedOnly: hasFlag(args, "changed-only"),
        includeAncestors: hasFlag(args, "include-ancestors"),
        includeEventMetadata: hasFlag(args, "no-event-metadata") ? false : undefined,
      });
      dependencies.print(response);
      return;
    }

    if (subcommand === "heap-update" || subcommand === "resolved-update") {
      const rootId =
        args.positionals[2] || flagString(args, "drop") || flagString(args, "id");
      const branchId = args.positionals[3] || flagString(args, "branch");
      if (!rootId || !branchId) {
        throw new Error("Usage: nd branch heap-update <rootId> <branchId>");
      }
      const snapshotId = flagString(args, "snapshot") || flagString(args, "snapshotId");
      const response = await dependencies.runtime.resolved.update({
        rootId,
        branchId,
        resolverId: flagString(args, "resolver") || flagString(args, "resolverId") || "all",
        snapshotId: snapshotId
          ? /^\d+$/.test(snapshotId)
            ? Number.parseInt(snapshotId, 10)
            : snapshotId
          : null,
      });
      dependencies.print(response);
      return;
    }

    if (subcommand === "promote") {
      const rootId =
        args.positionals[2] || flagString(args, "drop") || flagString(args, "id");
      const branchId = args.positionals[3] || flagString(args, "branch");
      if (!rootId || !branchId) {
        throw new Error("Usage: nd branch promote <rootId> <branchId>");
      }
      const response = await dependencies.runtime.branches.promote(rootId, branchId);
      const url =
        response && typeof response === "object" && "url" in response
          ? (response as { url?: string }).url
          : undefined;
      dependencies.print(response, `promoted ${url ?? "branch"}`);
      return;
    }

    if (subcommand === "memory" || subcommand === "mem") {
      const action = args.positionals[2];
      const rootId =
        args.positionals[3] || flagString(args, "drop") || flagString(args, "id");
      const branchId = args.positionals[4] || flagString(args, "branch");
      if (!rootId || !branchId) {
        throw new Error(
          "Usage: nd branch memory <query|fact|procedure|delete|stale-check> <rootId> <branchId>",
        );
      }

      const labels = parseLabels(args);

      if (action === "query" || action === "search" || action === "q") {
        const response = await dependencies.runtime.memory.query({
          rootId,
          branchId,
          query: flagString(args, "query") || flagString(args, "q"),
          kind: flagString(args, "kind"),
          labels,
          limit: flagString(args, "limit"),
          procedureId:
            flagString(args, "procedure") ||
            flagString(args, "procedure-id") ||
            flagString(args, "procedureId") ||
            flagString(args, "record-id") ||
            flagString(args, "recordId"),
          afterStep: flagString(args, "after-step") || flagString(args, "afterStep"),
          stepLimit: flagString(args, "step-limit") || flagString(args, "stepLimit"),
          includeFreshness: Boolean(
            flagString(args, "fresh") ||
              flagString(args, "freshness") ||
              flagString(args, "stale"),
          ),
          includeRecords: hasFlag(args, "no-records") ? false : undefined,
        });
        dependencies.print(response);
        return;
      }

      if (action === "fact" || action === "note") {
        const text = flagString(args, "text") || flagString(args, "body");
        if (!text) {
          throw new Error(
            "Usage: nd branch memory fact <rootId> <branchId> --text <text>",
          );
        }
        const response = await dependencies.runtime.memory.fact({
          rootId,
          branchId,
          text,
          title: flagString(args, "title"),
          targetKind: flagString(args, "target-kind") || flagString(args, "targetKind"),
          targetId: flagString(args, "target") || flagString(args, "targetId"),
          labels,
          priority: parseNumberFlag(args, "priority"),
          confidence: parseNumberFlag(args, "confidence"),
          metadata: await dependencies.parseMetadata(args),
        });
        dependencies.print(response);
        return;
      }

      if (action === "procedure" || action === "proc") {
        const goal = flagString(args, "goal");
        const summary = flagString(args, "summary");
        if (!goal || !summary) {
          throw new Error(
            "Usage: nd branch memory procedure <rootId> <branchId> --goal <text> --summary <text>",
          );
        }
        const stepsRaw =
          flagString(args, "steps") ||
          flagString(args, "steps-json") ||
          flagString(args, "stepsJson");
        const response = await dependencies.runtime.memory.procedure({
          rootId,
          branchId,
          goal,
          summary,
          steps: stepsRaw ? dependencies.parseJsonLoose(stepsRaw) : undefined,
          outcome: flagString(args, "outcome"),
          reusableAs: flagString(args, "reusable-as") || flagString(args, "reusableAs"),
          labels,
          priority: parseNumberFlag(args, "priority"),
          confidence: parseNumberFlag(args, "confidence"),
          metadata: await dependencies.parseMetadata(args),
        });
        dependencies.print(response);
        return;
      }

      if (action === "delete" || action === "del" || action === "rm") {
        const recordId =
          args.positionals[5] || flagString(args, "record") || flagString(args, "recordId");
        if (!recordId) {
          throw new Error(
            "Usage: nd branch memory delete <rootId> <branchId> <recordId>",
          );
        }
        const response = await dependencies.runtime.memory.delete({
          rootId,
          branchId,
          recordId,
        });
        dependencies.print(response);
        return;
      }

      if (
        action === "stale-check" ||
        action === "stale" ||
        action === "freshness" ||
        action === "fresh"
      ) {
        const response = await dependencies.runtime.memory.query({
          rootId,
          branchId,
          query: flagString(args, "query") || flagString(args, "q"),
          kind: flagString(args, "kind"),
          labels,
          limit: flagString(args, "limit"),
          includeFreshness: true,
        });
        dependencies.print(response);
        return;
      }

      throw new Error(
        "Usage: nd branch memory <query|fact|procedure|delete|stale-check> <rootId> <branchId>",
      );
    }

    if (subcommand === "priority" || subcommand === "prioritize") {
      const action = args.positionals[2];

      if (action === "list" || action === "ls") {
        const rootId =
          args.positionals[3] || flagString(args, "drop") || flagString(args, "id");
        const branchId = args.positionals[4] || flagString(args, "branch");
        if (!rootId || !branchId) {
          throw new Error("Usage: nd branch priority list <rootId> <branchId>");
        }
        const response = await dependencies.runtime.priority.list({
          rootId,
          branchId,
          resolverId: flagString(args, "resolver") || flagString(args, "resolverId"),
          targetKind: flagString(args, "target-kind") || flagString(args, "targetKind"),
          targetId: flagString(args, "target") || flagString(args, "targetId"),
          factId: flagString(args, "fact") || flagString(args, "factId"),
          limit: flagString(args, "limit"),
        });
        dependencies.print(response);
        return;
      }

      if (action === "delete" || action === "del" || action === "rm") {
        const rootId =
          args.positionals[3] || flagString(args, "drop") || flagString(args, "id");
        const branchId = args.positionals[4] || flagString(args, "branch");
        const factId =
          args.positionals[5] || flagString(args, "fact") || flagString(args, "factId");
        if (!rootId || !branchId || !factId) {
          throw new Error(
            "Usage: nd branch priority delete <rootId> <branchId> <factId>",
          );
        }
        const response = await dependencies.runtime.priority.delete({
          rootId,
          branchId,
          factId,
        });
        dependencies.print(response);
        return;
      }

      const rootId =
        args.positionals[2] || flagString(args, "drop") || flagString(args, "id");
      const branchId = args.positionals[3] || flagString(args, "branch");
      if (!rootId || !branchId) {
        throw new Error(
          "Usage: nd branch priority <rootId> <branchId> --priority <n>",
        );
      }

      const priority = parseNumberFlag(args, "priority") ?? parseNumberFlag(args, "score");
      if (!Number.isFinite(priority)) {
        throw new Error("nd branch priority requires --priority <number>.");
      }

      const nodeTarget = flagString(args, "node") || flagString(args, "nodeId");
      const diffTarget =
        flagString(args, "diff") || flagString(args, "event") || flagString(args, "eventId");
      const explicitTarget = flagString(args, "target") || flagString(args, "targetId");
      const requestedTargetKind = hasFlag(args, "heap")
        ? "heap"
        : nodeTarget
          ? "node"
          : diffTarget
            ? "diff"
            : flagString(args, "target-kind") || flagString(args, "targetKind") || "node";
      const targetKind = parsePriorityTargetKind(requestedTargetKind);
      if (!targetKind) {
        throw new Error("Priority target kind must be node, heap, or diff.");
      }

      const response = await dependencies.runtime.priority.create({
        rootId,
        branchId,
        targetKind,
        priority: priority!,
        targetId: nodeTarget || diffTarget || explicitTarget,
        resolverId:
          flagString(args, "resolver") ||
          flagString(args, "resolverId") ||
          (targetKind === "node" ? dependencies.defaultDocumentResolverId : undefined),
        reason: flagString(args, "reason"),
        labels: parseLabels(args),
        metadata: await dependencies.parseMetadata(args),
        sourceSeq: parseNumberFlag(args, "source-seq") ?? parseNumberFlag(args, "sourceSeq"),
        sourceEventId: flagString(args, "source-event") || flagString(args, "sourceEventId"),
      });
      dependencies.print(response);
      return;
    }

    throw new Error(
      "Usage: nd branch <list|resolve|content|snapshots|query|heap-update|memory|priority|promote>",
    );
  },
});

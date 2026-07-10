import { flagString, hasFlag } from "../core/args";
import type { ParsedArgs } from "../core/args";
import type { CliCommand } from "../core/command";
import type { NulldownRuntime } from "../runtime/types";
import {
  buildSeedCreateOutput,
  buildSeedDropContent,
  buildSeedDropMetadata,
  formatSeedHuman,
} from "../seed";

const parseLabels = (args: ParsedArgs): string[] =>
  flagString(args, "labels")
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean) ?? [];

const getDropMetadata = (body: unknown): Record<string, unknown> | undefined =>
  body && typeof body === "object" && !Array.isArray(body) && "metadata" in body
    ? ((body as { metadata?: unknown }).metadata as Record<string, unknown> | undefined)
    : undefined;

/** Dependencies used by modular drop read commands. */
export interface DropCommandDependencies {
  /** Runtime facade for drop operations. */
  runtime: NulldownRuntime;
  /** Prints command output using the active CLI output policy. */
  print(value: unknown, human?: string): void;
  /** Redacts sensitive fields before human JSON rendering. */
  redact(value: unknown): unknown;
  /** Writes raw text output. */
  writeText(text: string): void;
  /** Reads command input from a file path or stdin marker. */
  readInput(path: string | null): Promise<string>;
  /** Parses metadata flags using the active CLI input policy. */
  parseMetadata(args: ParsedArgs): Promise<Record<string, unknown> | undefined>;
  /** Returns whether seed creation should auto-resolve a branch. */
  shouldResolveSeedBranch(): boolean;
}

/** Creates modular drop commands. */
export const createDropCommands = <TConfig>(
  dependencies: DropCommandDependencies,
): CliCommand<TConfig>[] => [
  {
    name: "create",
    async run({ args }) {
      const seed = hasFlag(args, "seed") || flagString(args, "seed") !== null;
      const source = args.positionals[1] ?? "-";
      const metadataOverride = await dependencies.parseMetadata(args);
      const labels = parseLabels(args);
      const content = seed
        ? buildSeedDropContent({
            title:
              flagString(args, "title") ||
              flagString(args, "seed") ||
              args.positionals[1] ||
              "Untitled Nulldown Seed",
            intent: flagString(args, "intent"),
            labels,
          })
        : await dependencies.readInput(source);
      const metadata = seed
        ? buildSeedDropMetadata(labels, metadataOverride)
        : (metadataOverride ?? { themeId: "system" });
      const drop = await dependencies.runtime.drops.create({ content, metadata });
      if (!seed) {
        dependencies.print(drop, `created ${drop.url}`);
        return;
      }

      let branch: unknown;
      let branchResolveError: string | null = null;
      const forceResolve = hasFlag(args, "resolve-branch");
      const shouldResolve =
        forceResolve ||
        (!hasFlag(args, "no-resolve-branch") && dependencies.shouldResolveSeedBranch());
      if (shouldResolve) {
        try {
          branch = await dependencies.runtime.branches.resolve(drop.id);
        } catch (error) {
          if (forceResolve) throw error;
          branchResolveError = error instanceof Error ? error.message : String(error);
        }
      }

      const output = buildSeedCreateOutput({
        drop,
        branch,
        branchResolveError,
      });
      dependencies.print(output, formatSeedHuman(output));
    },
  },
  {
    name: "update",
    async run({ args }) {
      const id = args.positionals[1];
      const source = args.positionals[2] ?? "-";
      if (!id) throw new Error("Usage: nd update <id> <file|->");
      const current = await dependencies.runtime.drops.get(id);
      const content = await dependencies.readInput(source);
      const metadataOverride = await dependencies.parseMetadata(args);
      const currentMetadata = getDropMetadata(current.body);
      const metadata = metadataOverride
        ? { ...(currentMetadata ?? {}), ...metadataOverride }
        : (currentMetadata ?? { themeId: "system" });
      const response = await dependencies.runtime.drops.update({
        id: current.id,
        content,
        metadata,
        expectedRevision: hasFlag(args, "force") ? null : current.revision,
      });
      dependencies.print(response, `updated ${response.url}`);
    },
  },
  {
    name: "get",
    async run({ args }) {
      const id = args.positionals[1];
      if (!id) throw new Error("Usage: nd get <id>");
      const drop = await dependencies.runtime.drops.get(id);
      if (hasFlag(args, "raw")) {
        if (drop.body && typeof drop.body === "object" && "content" in drop.body) {
          dependencies.writeText(String((drop.body as { content: unknown }).content));
          return;
        }
        dependencies.writeText(drop.text);
        return;
      }
      dependencies.print(
        drop,
        typeof drop.body === "string"
          ? drop.body
          : JSON.stringify(dependencies.redact(drop.body), null, 2),
      );
    },
  },
  {
    name: "list",
    async run({ args }) {
      const response = await dependencies.runtime.drops.list({
        limit: flagString(args, "limit"),
        cursor: flagString(args, "cursor"),
      });
      dependencies.print(response);
    },
  },
  {
    name: "delete",
    async run({ args }) {
      const id = args.positionals[1];
      if (!id) throw new Error("Usage: nd delete <id>");
      const response = await dependencies.runtime.drops.delete(id, {
        force: hasFlag(args, "force"),
      });
      dependencies.print(response, `deleted ${id}`);
    },
  },
  {
    name: "search",
    async run({ args }) {
      const response = await dependencies.runtime.drops.search({
        query: args.positionals[1] ?? flagString(args, "query"),
        owner: flagString(args, "owner"),
        visibility: flagString(args, "visibility"),
        limit: flagString(args, "limit"),
        offset: flagString(args, "offset"),
      });
      dependencies.print(response);
    },
  },
];

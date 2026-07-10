import { flagString, type ParsedArgs } from "../core/args";
import type { CliCommand } from "../core/command";
import type { AdminBackfillTarget, NulldownRuntime } from "../runtime/types";

const ADMIN_BACKFILL_TARGETS = new Set<AdminBackfillTarget>([
  "branch-backfill",
  "index-backfill",
  "metadata-backfill",
]);

const defaultLimit = (target: AdminBackfillTarget): string => {
  if (target === "metadata-backfill") return "500";
  if (target === "index-backfill") return "200";
  return "100";
};

const backfillTarget = (args: ParsedArgs): AdminBackfillTarget | null => {
  const target = args.positionals[1];
  return ADMIN_BACKFILL_TARGETS.has(target as AdminBackfillTarget)
    ? (target as AdminBackfillTarget)
    : null;
};

const nextCursor = (value: unknown): string | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? ((value as { cursor?: string | null }).cursor ?? undefined)
    : undefined;

const isTruncated = (value: unknown): boolean =>
  Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (value as { truncated?: boolean }).truncated,
  );

/** Dependencies used by modular admin commands. */
export interface AdminCommandDependencies {
  /** Runtime facade for admin operations. */
  runtime: NulldownRuntime;
  /** Prints command output using the active CLI output policy. */
  print(value: unknown, human?: string): void;
  /** Resolves the admin token for the requested backfill target. */
  resolveAdminToken(target: AdminBackfillTarget, args: ParsedArgs): string | null;
  /** Sleeps between paginated admin batches. */
  sleep(ms: number): Promise<void>;
}

/** Creates the modular admin command. */
export const createAdminCommand = <TConfig>(
  dependencies: AdminCommandDependencies,
): CliCommand<TConfig> => ({
  name: "admin",
  async run({ args }) {
    const target = backfillTarget(args);
    if (!target) {
      throw new Error(
        "Usage: nd admin <branch-backfill|index-backfill|metadata-backfill>",
      );
    }

    const limit = flagString(args, "limit") || defaultLimit(target);
    const maxBatches = Number.parseInt(
      flagString(args, "max-batches") || "1000",
      10,
    );
    let cursor = flagString(args, "cursor") ?? undefined;
    const token = dependencies.resolveAdminToken(target, args);
    if (!token) {
      throw new Error("Missing admin token. Use --token or relevant env var.");
    }
    const rootId =
      args.positionals[2] || flagString(args, "drop") || flagString(args, "id");
    if (target === "branch-backfill" && !rootId) {
      throw new Error("Usage: nd admin branch-backfill <rootId>");
    }

    const batches: unknown[] = [];
    for (let batch = 0; batch < maxBatches; batch += 1) {
      const response = await dependencies.runtime.admin.backfill({
        target,
        rootId,
        token,
        limit,
        cursor,
      });
      batches.push(response);
      cursor = nextCursor(response);
      if (!isTruncated(response) || !cursor) break;
      await dependencies.sleep(Number.parseInt(flagString(args, "retry-ms") || "50", 10));
    }

    dependencies.print({ batches });
  },
});

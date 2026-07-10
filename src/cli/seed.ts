interface SeedDropInput {
  title: string;
  intent?: string | null;
  labels?: string[];
}

interface SeedCreateOutputInput {
  drop: { id: string; url: string };
  branch?: unknown;
  branchResolveError?: string | null;
}

const DEFAULT_SEED_INTENT =
  "Build this Nulldown incrementally with branch diffs and facts.";

const branchIdFromResponse = (value: unknown): string | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const branchId = (value as { branchId?: unknown }).branchId;
  return typeof branchId === "string" && branchId ? branchId : undefined;
};

/** Builds the intentionally tiny root body for branch-first authoring. */
export const buildSeedDropContent = (input: SeedDropInput): string => {
  const title = input.title.trim() || "Untitled Nulldown Seed";
  const intent = input.intent?.trim() || DEFAULT_SEED_INTENT;
  const labels = input.labels?.filter(Boolean) ?? [];
  const lines = [
    `# ${title}`,
    "",
    `Intent: ${intent}`,
    "",
    "Build protocol: resolve a branch, append focused sections with `nd diff apply`, and record reusable facts with `nd branch memory fact`.",
  ];

  if (labels.length) {
    lines.push("", `Labels: ${labels.map((label) => `\`${label}\``).join(", ")}`);
  }

  lines.push("", "## Sections", "");
  return `${lines.join("\n")}\n`;
};

/** Builds metadata that marks a drop as a semantic seed instead of a finished doc. */
export const buildSeedDropMetadata = (
  labels: string[],
  override?: Record<string, unknown>,
): Record<string, unknown> => ({
  themeId: "system",
  docKind: "semantic-seed",
  seed: true,
  retrievalTags: labels,
  ...(override ?? {}),
});

/** Builds concise next commands for continuing a seed with atomic diffs. */
export const buildSeedNextCommands = (
  dropId: string,
  branchId?: string,
): Record<string, string> => {
  const branch = branchId || "<branchId>";
  return {
    resolveBranch: `nd branch resolve ${dropId} --json`,
    appendSection: `nd diff apply ${dropId} --branch ${branch} --insert '0:\n## Section\n\nText.\n' --metadata '{"kind":"agent.edit","intent":"Add semantic section","labels":["semantic-seed"],"args":{"summary":"Adds one focused section.","priority":0.5},"confidence":0.9}' --json`,
    recordFact: `nd branch memory fact ${dropId} ${branch} --title 'Seed fact' --text 'Reusable fact.' --labels semantic-seed --json`,
  };
};

/** Builds the machine-readable output for semantic seed creation. */
export const buildSeedCreateOutput = (input: SeedCreateOutputInput) => {
  const branchId = branchIdFromResponse(input.branch);
  return {
    ...input.drop,
    seed: true,
    branch: input.branch ?? null,
    branchResolveError: input.branchResolveError ?? null,
    next: buildSeedNextCommands(input.drop.id, branchId),
  };
};

/** Formats seed creation output for human CLI display. */
export const formatSeedHuman = (
  output: ReturnType<typeof buildSeedCreateOutput>,
): string => {
  const branchId = branchIdFromResponse(output.branch);
  const lines = [`created seed ${output.url}`];
  if (branchId) lines.push(`branch ${branchId}`);
  if (output.branchResolveError) {
    lines.push(`branch resolve skipped: ${output.branchResolveError}`);
  }
  lines.push("next:", `  ${output.next.resolveBranch}`, `  ${output.next.appendSection}`);
  return lines.join("\n");
};

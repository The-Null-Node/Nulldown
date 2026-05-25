import { toShortDropId, isDropIdToken } from "../../../../shared/drop/id";
import type { DropMetadata, DropPayload } from "../../../../shared/drop/types";
import { getMarkdownTitle } from "../../markdownText";
import { nullplug } from "../registry";
import type { NullplugContext, NullplugHandler, PluginBlock } from "../types";

interface NdInvocation {
  id: string;
}

const ARG_PAIR_PATTERN = /([a-zA-Z][\w.-]*)\s*=\s*("[^"]*"|'[^']*'|[^,\s]+)/g;
const DROP_URL_PATTERN = /\/d\/([A-Za-z0-9_-]+)/;

const unwrapQuotedValue = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1).trim();
    }
  }

  return trimmed;
};

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const parseArgumentMap = (args: string | null): Record<string, string> => {
  if (!args) {
    return {};
  }

  const values: Record<string, string> = {};
  let match: RegExpExecArray | null;
  while ((match = ARG_PAIR_PATTERN.exec(args)) !== null) {
    const key = match[1]?.toLowerCase();
    const value = match[2];
    if (key && value !== undefined) {
      values[key] = unwrapQuotedValue(value);
    }
  }

  if (!values.id && !values.drop && !values.src) {
    const shorthand = unwrapQuotedValue(args);
    if (shorthand) {
      values.id = shorthand;
    }
  }

  return values;
};

const firstMeaningfulBodyValue = (blockContent: string): string => {
  const line = blockContent
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);

  if (!line) {
    return "";
  }

  const idMatch = /^id\s*=\s*(.+)$/i.exec(line);
  return unwrapQuotedValue(idMatch?.[1] ?? line);
};

const extractDropId = (value: string): string => {
  const trimmed = unwrapQuotedValue(value);
  if (!trimmed) {
    return "";
  }

  const urlMatch = DROP_URL_PATTERN.exec(trimmed);
  if (urlMatch?.[1]) {
    return urlMatch[1];
  }

  return trimmed;
};

const parseNdInvocation = (
  blockContent: string,
  argsValue: string | null,
): NdInvocation | null => {
  const args = parseArgumentMap(argsValue);
  const rawId = args.id || args.drop || args.src || firstMeaningfulBodyValue(blockContent);
  const id = extractDropId(rawId);

  if (!id || !isDropIdToken(id)) {
    return null;
  }

  return {
    id,
  };
};

const linkIdForDrop = (id: string): string => {
  if (id.startsWith("offline_")) {
    return id;
  }

  return id.length > 6 ? toShortDropId(id) : id;
};

const stripMarkdownForPreview = (markdown: string): string =>
  markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/~~~[\s\S]*?~~~/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`{1,3}([^`]+)`{1,3}/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s{0,3}[-*+]\s+/gm, "")
    .replace(/^\s{0,3}\d+[.)]\s+/gm, "")
    .replace(/[*_~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();

const truncate = (value: string, maxLength: number): string => {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 1).trimEnd()}...`;
};

const getMetadataHints = (metadata: DropMetadata | undefined): string[] => {
  if (!metadata) {
    return [];
  }

  const hints: string[] = [];
  if (typeof metadata.rootDropId === "string") {
    hints.push(`root ${linkIdForDrop(metadata.rootDropId)}`);
  }
  if (typeof metadata.baseDropId === "string") {
    hints.push(`base ${linkIdForDrop(metadata.baseDropId)}`);
  }
  if (typeof metadata.snapshotId === "number") {
    hints.push(`snapshot ${metadata.snapshotId}`);
  }
  if (typeof metadata.themeId === "string") {
    hints.push(`theme ${metadata.themeId}`);
  }

  return hints.slice(0, 3);
};

const buildCardHtml = (input: {
  id: string;
  payload: DropPayload;
}): string => {
  const { id, payload } = input;
  const shortId = linkIdForDrop(id);
  const href = `/d/${encodeURIComponent(shortId)}`;
  const title = getMarkdownTitle(payload.content) || `Nulldown ${shortId}`;
  const preview = truncate(stripMarkdownForPreview(payload.content), 220);
  const hints = [`id ${shortId}`, ...getMetadataHints(payload.metadata)];
  const hintHtml = hints
    .map(
      (hint) =>
        `<span class="nd-card-hint rounded-full border border-border/70 px-2 py-0.5">${escapeHtml(
          hint,
        )}</span>`,
    )
    .join("");

  return `<div class="nd-card my-4 rounded-xl border border-border bg-card/80 p-4 shadow-sm transition-colors hover:border-accent/70"><div class="nd-card-kicker mb-1 text-xs font-medium uppercase tracking-[0.2em] text-muted">Nulldown Drop</div><a href="${escapeHtml(
    href,
  )}" class="nd-card-title text-lg font-semibold text-foreground no-underline hover:text-accent">${escapeHtml(
    title,
  )}</a><div class="nd-card-preview mt-2 text-sm leading-6 text-muted">${escapeHtml(
    preview || "No preview text available.",
  )}</div><div class="nd-card-meta mt-3 flex flex-wrap gap-2 text-[11px] text-muted">${hintHtml}</div></div>`;
};

const buildStatusCardHtml = (title: string, detail: string): string =>
  `<div class="nd-card my-4 rounded-xl border border-border bg-card/80 p-4 text-sm text-muted"><div class="mb-1 font-medium text-foreground">${escapeHtml(
    title,
  )}</div><div>${escapeHtml(detail)}</div></div>`;

const nd: NullplugHandler & { pluginId: string } = Object.assign(
  async (ctx: NullplugContext, blockContent: string, block: PluginBlock) => {
    const invocation = parseNdInvocation(blockContent, block.args);
    if (!invocation) {
      return {
        text: buildStatusCardHtml(
          "Invalid nd block",
          "Add id=\"dropId\" in the fence args or put a drop id on the first line.",
        ),
      };
    }

    if (ctx.visitedDropIds.size >= ctx.maxDepth) {
      return {
        text: buildStatusCardHtml(
          "nd recursion limit reached",
          `Skipped ${invocation.id} because this render has already visited ${ctx.visitedDropIds.size} drops.`,
        ),
      };
    }

    if (!ctx.resolveDrop) {
      return {
        text: buildStatusCardHtml(
          "nd resolver unavailable",
          `Open /d/${linkIdForDrop(invocation.id)} to view this drop.`,
        ),
      };
    }

    try {
      const payload = await ctx.resolveDrop(invocation.id);
      if (!payload) {
        return {
          text: buildStatusCardHtml(
            "Drop not found",
            `No Nulldown drop was found for ${invocation.id}.`,
          ),
        };
      }

      return {
        text: buildCardHtml({ id: invocation.id, payload }),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        text: buildStatusCardHtml(
          "Unable to load nd card",
          `${invocation.id}: ${message}`,
        ),
      };
    }
  },
  { pluginId: "nd" },
);

nullplug(nd);

import { nullplug } from "../registry";
import type { NullplugContext, NullplugHandler, PluginBlock } from "../types";

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

const extractEmbedSource = (blockContent: string): string => {
  const lines = blockContent
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (!lines.length) {
    return "";
  }

  const firstLine = lines[0];
  const srcMatch = /^src\s*=\s*(.+)$/i.exec(firstLine);
  if (srcMatch?.[1]) {
    return unwrapQuotedValue(srcMatch[1]);
  }

  return unwrapQuotedValue(firstLine);
};

const extractEmbedSourceFromArgs = (args: string | null): string => {
  if (!args) {
    return "";
  }

  const srcMatch = /^src\s*=\s*(.+)$/i.exec(args.trim());
  if (srcMatch?.[1]) {
    return unwrapQuotedValue(srcMatch[1]);
  }

  return unwrapQuotedValue(args);
};

const escapeHtmlAttribute = (value: string): string => {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
};

const embed: NullplugHandler & { pluginId: string } = Object.assign(
  (ctx: NullplugContext, blockContent: string, block: PluginBlock) => {
    const rawSource =
      extractEmbedSourceFromArgs(block.args) || extractEmbedSource(blockContent);
    if (!rawSource) {
      return {
        text: "> Embed block is empty. Add a URL on the first line.",
      };
    }

    const trustedSource = ctx.toTrustedEmbedUrl(rawSource);
    if (!trustedSource) {
      let host = "";
      try {
        const parsed = new URL(
          /^https?:\/\//i.test(rawSource) ? rawSource : `https://${rawSource}`,
        );
        host = escapeHtmlAttribute(parsed.hostname);
      } catch {
        host = escapeHtmlAttribute(rawSource);
      }
      return {
        text: `<div class="blocked-embed" data-host="${host}">Blocked embed from untrusted host.</div>`,
      };
    }

    const safeSource = escapeHtmlAttribute(trustedSource);

    return {
      text: `<iframe src="${safeSource}" title="Embedded content" width="100%" height="360" allow="fullscreen; encrypted-media" allowfullscreen loading="lazy" referrerpolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin allow-presentation"></iframe>`,
    };
  },
  { pluginId: "embed" },
);

nullplug(embed);

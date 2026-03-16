import { nullplug } from "../registry";

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

const escapeHtmlAttribute = (value: string): string => {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
};

nullplug("embed")((ctx, blockContent) => {
  const rawSource = extractEmbedSource(blockContent);
  if (!rawSource) {
    return {
      text: "> Embed block is empty. Add a URL on the first line.",
    };
  }

  const trustedSource = ctx.toTrustedEmbedUrl(rawSource);
  if (!trustedSource) {
    return {
      text: "> Blocked embed from untrusted host.",
    };
  }

  const safeSource = escapeHtmlAttribute(trustedSource);

  return {
    text: `<iframe src="${safeSource}" title="Embedded content" width="100%" height="360" allow="fullscreen; encrypted-media" allowfullscreen loading="lazy" referrerpolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin allow-presentation"></iframe>`,
  };
});

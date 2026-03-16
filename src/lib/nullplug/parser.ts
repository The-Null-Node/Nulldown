import type { PluginBlock } from "./types";

const PLUGIN_INFO_PATTERN = /^plugin\(\s*(["'])([a-z0-9._:-]+)\1\s*\)$/i;

const parseFenceHeader = (
  line: string,
): { fenceChar: "`" | "~"; fenceLength: number; info: string } | null => {
  const trimmed = line.trimStart();
  const first = trimmed[0];

  if (first !== "`" && first !== "~") {
    return null;
  }

  let fenceLength = 0;
  while (trimmed[fenceLength] === first) {
    fenceLength += 1;
  }

  if (fenceLength < 3) {
    return null;
  }

  return {
    fenceChar: first,
    fenceLength,
    info: trimmed.slice(fenceLength).trim(),
  };
};

const isFenceCloser = (
  line: string,
  fenceChar: "`" | "~",
  minFenceLength: number,
): boolean => {
  const trimmed = line.trim();
  if (trimmed.length < minFenceLength) {
    return false;
  }

  if (trimmed[0] !== fenceChar) {
    return false;
  }

  for (let index = 0; index < trimmed.length; index += 1) {
    if (trimmed[index] !== fenceChar) {
      return false;
    }
  }

  return true;
};

const nextLineEnd = (value: string, start: number): number => {
  const index = value.indexOf("\n", start);
  return index === -1 ? value.length : index;
};

export const parsePluginId = (info: string): string | null => {
  const match = PLUGIN_INFO_PATTERN.exec(info.trim());
  if (!match?.[2]) {
    return null;
  }

  return match[2].trim().toLowerCase();
};

export const parseNullplugBlocks = (markdown: string): PluginBlock[] => {
  const blocks: PluginBlock[] = [];

  let cursor = 0;
  while (cursor < markdown.length) {
    const lineStart = cursor;
    const lineEnd = nextLineEnd(markdown, lineStart);
    const line = markdown.slice(lineStart, lineEnd);

    const fenceHeader = parseFenceHeader(line);
    if (!fenceHeader) {
      cursor = lineEnd < markdown.length ? lineEnd + 1 : markdown.length;
      continue;
    }

    const pluginId = parsePluginId(fenceHeader.info);
    if (!pluginId) {
      cursor = lineEnd < markdown.length ? lineEnd + 1 : markdown.length;
      continue;
    }

    const contentStart = lineEnd < markdown.length ? lineEnd + 1 : markdown.length;

    let search = contentStart;
    let closeLineStart = -1;
    let blockEnd = markdown.length;

    while (search <= markdown.length) {
      const candidateEnd = nextLineEnd(markdown, search);
      const candidate = markdown.slice(search, candidateEnd);

      if (
        isFenceCloser(
          candidate,
          fenceHeader.fenceChar,
          fenceHeader.fenceLength,
        )
      ) {
        closeLineStart = search;
        blockEnd =
          candidateEnd < markdown.length ? candidateEnd + 1 : markdown.length;
        break;
      }

      if (candidateEnd === markdown.length) {
        break;
      }

      search = candidateEnd + 1;
    }

    if (closeLineStart === -1) {
      cursor = lineEnd < markdown.length ? lineEnd + 1 : markdown.length;
      continue;
    }

    blocks.push({
      id: pluginId,
      start: lineStart,
      end: blockEnd,
      content: markdown.slice(contentStart, closeLineStart),
      info: fenceHeader.info,
    });

    cursor = blockEnd;
  }

  return blocks;
};

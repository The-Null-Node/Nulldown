/*
Nullplug piggybacks on fenced code blocks. The parser intentionally accepts only fully
closed fences with conservative plugin ids so plugin execution never depends on loose
markdown parsing or partial user input.
*/

import type { PluginBlock } from "./types";
import type { JsonValue } from "../../../shared/nullplug/types";
import {
  parseNullplugFenceInvocation,
  type NullplugFenceInvocation,
} from "../../../shared/nullplug/fence";

export type ParsedPluginInvocation = NullplugFenceInvocation;

const trimFenceIndent = (line: string): string | null => {
  const indentation = /^[ \t]*/.exec(line)?.[0] ?? "";
  if (indentation.includes("\t") || indentation.length > 3) return null;
  return line.slice(indentation.length);
};

const parseFenceHeader = (
  line: string,
): { fenceChar: "`" | "~"; fenceLength: number; info: string } | null => {
  const trimmed = trimFenceIndent(line);
  if (trimmed === null) return null;
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
  const indented = trimFenceIndent(line);
  if (indented === null) return false;
  const trimmed = indented.trimEnd();
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

const ARGUMENT_PAIR_PATTERN =
  /([a-zA-Z][\w.-]*)\s*=\s*("[^"]*"|'[^']*'|[^,\s]+)/g;

const parseArgumentValue = (raw: string): JsonValue => {
  const trimmed = raw.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  const numeric = Number(trimmed);
  return trimmed && Number.isFinite(numeric) ? numeric : trimmed;
};

/** Parses conservative fence arguments into the shared invocation DTO shape. */
export const parseNullplugArguments = (
  value: string | null,
): Record<string, JsonValue> => {
  if (!value) return {};
  const args: Record<string, JsonValue> = {};
  let match: RegExpExecArray | null;
  while ((match = ARGUMENT_PAIR_PATTERN.exec(value)) !== null) {
    if (match[1] && match[2] !== undefined) {
      args[match[1]] = parseArgumentValue(match[2]);
    }
  }
  return Object.keys(args).length ? args : { value: parseArgumentValue(value) };
};

export const parsePluginInvocation = (
  info: string,
): ParsedPluginInvocation | null => parseNullplugFenceInvocation(info);

export const parsePluginId = (info: string): string | null => {
  const invocation = parsePluginInvocation(info);
  if (!invocation) {
    return null;
  }

  return invocation.id;
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

    const invocation = parsePluginInvocation(fenceHeader.info);
    if (!invocation) {
      cursor = lineEnd < markdown.length ? lineEnd + 1 : markdown.length;
      continue;
    }

    const contentStart =
      lineEnd < markdown.length ? lineEnd + 1 : markdown.length;

    let search = contentStart;
    let closeLineStart = -1;
    let blockEnd = markdown.length;

    while (search <= markdown.length) {
      const candidateEnd = nextLineEnd(markdown, search);
      const candidate = markdown.slice(search, candidateEnd);

      if (
        isFenceCloser(candidate, fenceHeader.fenceChar, fenceHeader.fenceLength)
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
      // Unterminated fences stay as plain markdown so typing half a plugin block is harmless.
      cursor = lineEnd < markdown.length ? lineEnd + 1 : markdown.length;
      continue;
    }

    blocks.push({
      id: invocation.id,
      args: invocation.args,
      invocationForm: invocation.form,
      start: lineStart,
      end: blockEnd,
      content: markdown.slice(contentStart, closeLineStart),
      info: fenceHeader.info,
    });

    cursor = blockEnd;
  }

  return blocks;
};

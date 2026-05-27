const headingPattern = /^\s{0,3}#{1,6}\s+/;
const blockquotePattern = /^\s{0,3}>\s+/;
const unorderedListPattern = /^\s{0,3}[-*+]\s+/;
const orderedListPattern = /^\s{0,3}\d+[.)]\s+/;

const linkPattern = /\[([^\]]+)\]\([^)]*\)/g;
const imagePattern = /!\[([^\]]*)\]\([^)]*\)/g;
const inlineCodePattern = /`{1,3}([^`]+)`{1,3}/g;
const emphasisPattern = /[*_~]+/g;

export function getMarkdownTitle(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const firstLine = lines.find((line) => line.trim().length > 0);
  if (!firstLine) return "";

  let title = firstLine.trim();
  title = title.replace(headingPattern, "");
  title = title.replace(blockquotePattern, "");
  title = title.replace(unorderedListPattern, "");
  title = title.replace(orderedListPattern, "");
  title = title.replace(imagePattern, "$1");
  title = title.replace(linkPattern, "$1");
  title = title.replace(inlineCodePattern, "$1");
  title = title.replace(emphasisPattern, "");
  title = title.replace(/\s+/g, " ").trim();
  return title;
}

const isDigit = (char: string) => char >= "0" && char <= "9";

const findUnescaped = (text: string, start: number, target: string): number => {
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === "\\") {
      i += 1;
      continue;
    }
    if (text[i] === target) return i;
  }
  return -1;
};

export function mapPlainTextOffsetToMarkdownIndex(
  markdown: string,
  plainTextOffset: number,
): number {
  const target = Math.max(0, plainTextOffset);
  if (!markdown.length) return 0;

  let plainIndex = 0;
  let firstVisibleIndex: number | null = null;
  let i = 0;
  let inCodeBlock = false;
  let codeFence = "";
  let inlineCode = false;
  let lineStart = true;

  const emit = (mdIndex: number): number | null => {
    if (firstVisibleIndex === null) {
      firstVisibleIndex = mdIndex;
      if (target === 0) {
        return mdIndex;
      }
    }
    plainIndex += 1;
    if (plainIndex === target) {
      return mdIndex + 1;
    }
    return null;
  };

  const skipLine = () => {
    while (i < markdown.length && markdown[i] !== "\n") {
      i += 1;
    }
    if (i < markdown.length && markdown[i] === "\n") {
      i += 1;
    }
    lineStart = true;
    inlineCode = false;
  };

  const emitLinkText = (start: number, end: number): number | null => {
    let j = start;
    while (j < end) {
      const char = markdown[j];
      if (char === "\\") {
        j += 1;
        if (j < end) {
          const result = emit(j);
          if (result !== null) return result;
          j += 1;
        }
        continue;
      }

      if (char === "~" && markdown[j + 1] === "~") {
        j += 2;
        continue;
      }

      if (char === "*" || char === "_" || char === "~" || char === "`") {
        j += 1;
        continue;
      }

      const result = emit(j);
      if (result !== null) return result;
      j += 1;
    }
    return null;
  };

  while (i < markdown.length) {
    const char = markdown[i];

    if (char === "\r") {
      i += 1;
      continue;
    }

    if (char === "\n") {
      const result = emit(i);
      i += 1;
      lineStart = true;
      inlineCode = false;
      if (result !== null) return result;
      continue;
    }

    if (lineStart) {
      if (char === "`" || char === "~") {
        let count = 0;
        while (markdown[i + count] === char) count += 1;
        if (count >= 3) {
          if (!inCodeBlock) {
            inCodeBlock = true;
            codeFence = char;
            skipLine();
            continue;
          }
          if (inCodeBlock && char === codeFence) {
            inCodeBlock = false;
            skipLine();
            continue;
          }
        }
      }

      if (!inCodeBlock) {
        if (char === "#") {
          let j = i;
          while (markdown[j] === "#") j += 1;
          if (markdown[j] === " ") {
            i = j + 1;
            lineStart = false;
            continue;
          }
        }

        if (char === ">") {
          let j = i + 1;
          if (markdown[j] === " ") j += 1;
          i = j;
          lineStart = false;
          continue;
        }

        if (
          (char === "-" || char === "*" || char === "+") &&
          markdown[i + 1] === " "
        ) {
          i += 2;
          lineStart = false;
          continue;
        }

        if (isDigit(char)) {
          let j = i;
          while (isDigit(markdown[j] ?? "")) j += 1;
          if (
            (markdown[j] === "." || markdown[j] === ")") &&
            markdown[j + 1] === " "
          ) {
            i = j + 2;
            lineStart = false;
            continue;
          }
        }
      }
    }

    if (!inCodeBlock && char === "`") {
      inlineCode = !inlineCode;
      i += 1;
      lineStart = false;
      continue;
    }

    if (!inCodeBlock && !inlineCode) {
      if (char === "!" && markdown[i + 1] === "[") {
        const linkEnd = findUnescaped(markdown, i + 2, "]");
        if (linkEnd !== -1 && markdown[linkEnd + 1] === "(") {
          const urlEnd = findUnescaped(markdown, linkEnd + 2, ")");
          if (urlEnd !== -1) {
            const result = emitLinkText(i + 2, linkEnd);
            if (result !== null) return result;
            i = urlEnd + 1;
            lineStart = false;
            continue;
          }
        }
      }

      if (char === "[") {
        const linkEnd = findUnescaped(markdown, i + 1, "]");
        if (linkEnd !== -1 && markdown[linkEnd + 1] === "(") {
          const urlEnd = findUnescaped(markdown, linkEnd + 2, ")");
          if (urlEnd !== -1) {
            const result = emitLinkText(i + 1, linkEnd);
            if (result !== null) return result;
            i = urlEnd + 1;
            lineStart = false;
            continue;
          }
        }
      }

      if (char === "~" && markdown[i + 1] === "~") {
        i += 2;
        lineStart = false;
        continue;
      }

      if (char === "*" || char === "_" || char === "~") {
        i += 1;
        lineStart = false;
        continue;
      }

      if (char === "\\" && i + 1 < markdown.length) {
        i += 1;
        const result = emit(i);
        i += 1;
        lineStart = false;
        if (result !== null) return result;
        continue;
      }
    }

    const result = emit(i);
    i += 1;
    lineStart = false;
    if (result !== null) return result;
  }

  if (target === 0) {
    return firstVisibleIndex ?? 0;
  }

  return markdown.length;
}

export function mapMarkdownIndexToPlainTextOffset(
  markdown: string,
  markdownIndex: number,
): number {
  const target = Math.max(0, Math.min(markdownIndex, markdown.length));

  if (target === 0 || !markdown.length) {
    return 0;
  }

  let plainOffset = 0;
  let i = 0;
  let inCodeBlock = false;
  let codeFence = "";
  let inlineCode = false;
  let lineStart = true;

  const emit = (mdIndex: number): boolean => {
    if (mdIndex >= target) {
      return true;
    }

    plainOffset += 1;
    return false;
  };

  const skipLine = () => {
    while (i < markdown.length && markdown[i] !== "\n") {
      i += 1;
    }
    if (i < markdown.length && markdown[i] === "\n") {
      i += 1;
    }
    lineStart = true;
    inlineCode = false;
  };

  const emitLinkText = (start: number, end: number): boolean => {
    let j = start;
    while (j < end) {
      const char = markdown[j];
      if (char === "\\") {
        j += 1;
        if (j < end) {
          if (emit(j)) return true;
          j += 1;
        }
        continue;
      }

      if (char === "~" && markdown[j + 1] === "~") {
        j += 2;
        continue;
      }

      if (char === "*" || char === "_" || char === "~" || char === "`") {
        j += 1;
        continue;
      }

      if (emit(j)) return true;
      j += 1;
    }
    return false;
  };

  while (i < markdown.length && i < target) {
    const char = markdown[i];

    if (char === "\r") {
      i += 1;
      continue;
    }

    if (char === "\n") {
      if (emit(i)) return plainOffset;
      i += 1;
      lineStart = true;
      inlineCode = false;
      continue;
    }

    if (lineStart) {
      if (char === "`" || char === "~") {
        let count = 0;
        while (markdown[i + count] === char) count += 1;
        if (count >= 3) {
          if (!inCodeBlock) {
            inCodeBlock = true;
            codeFence = char;
            skipLine();
            continue;
          }
          if (inCodeBlock && char === codeFence) {
            inCodeBlock = false;
            skipLine();
            continue;
          }
        }
      }

      if (!inCodeBlock) {
        if (char === "#") {
          let j = i;
          while (markdown[j] === "#") j += 1;
          if (markdown[j] === " ") {
            i = j + 1;
            lineStart = false;
            continue;
          }
        }

        if (char === ">") {
          let j = i + 1;
          if (markdown[j] === " ") j += 1;
          i = j;
          lineStart = false;
          continue;
        }

        if (
          (char === "-" || char === "*" || char === "+") &&
          markdown[i + 1] === " "
        ) {
          i += 2;
          lineStart = false;
          continue;
        }

        if (isDigit(char)) {
          let j = i;
          while (isDigit(markdown[j] ?? "")) j += 1;
          if (
            (markdown[j] === "." || markdown[j] === ")") &&
            markdown[j + 1] === " "
          ) {
            i = j + 2;
            lineStart = false;
            continue;
          }
        }
      }
    }

    if (!inCodeBlock && char === "`") {
      inlineCode = !inlineCode;
      i += 1;
      lineStart = false;
      continue;
    }

    if (!inCodeBlock && !inlineCode) {
      if (char === "!" && markdown[i + 1] === "[") {
        const linkEnd = findUnescaped(markdown, i + 2, "]");
        if (linkEnd !== -1 && markdown[linkEnd + 1] === "(") {
          const urlEnd = findUnescaped(markdown, linkEnd + 2, ")");
          if (urlEnd !== -1) {
            if (emitLinkText(i + 2, linkEnd)) return plainOffset;
            i = urlEnd + 1;
            lineStart = false;
            continue;
          }
        }
      }

      if (char === "[") {
        const linkEnd = findUnescaped(markdown, i + 1, "]");
        if (linkEnd !== -1 && markdown[linkEnd + 1] === "(") {
          const urlEnd = findUnescaped(markdown, linkEnd + 2, ")");
          if (urlEnd !== -1) {
            if (emitLinkText(i + 1, linkEnd)) return plainOffset;
            i = urlEnd + 1;
            lineStart = false;
            continue;
          }
        }
      }

      if (char === "~" && markdown[i + 1] === "~") {
        i += 2;
        lineStart = false;
        continue;
      }

      if (char === "*" || char === "_" || char === "~") {
        i += 1;
        lineStart = false;
        continue;
      }

      if (char === "\\" && i + 1 < markdown.length) {
        i += 1;
        if (emit(i)) return plainOffset;
        i += 1;
        lineStart = false;
        continue;
      }
    }

    if (emit(i)) return plainOffset;
    i += 1;
    lineStart = false;
  }

  return plainOffset;
}

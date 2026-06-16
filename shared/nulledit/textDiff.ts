/*
Nulledit uses a minimal prefix/suffix diff instead of a full LCS implementation.
That keeps keystroke diffs cheap and deterministic for snapshotting, local replay,
and branch transport, at the cost of only modeling one contiguous change at a time.

Diff generation is pluggable via the `Differ` interface. Current implementation
is `prefixSuffixDiffer`. Future algorithms (DP/LCS, Myers) will implement the same interface.
*/

import { DiffOp, type Diff, type DiffAlgorithm, type DiffOptions, type Differ } from "./types";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeText(value: string): ArrayBuffer {
  const encoded = encoder.encode(value);
  const out = new Uint8Array(encoded.byteLength);
  out.set(encoded);
  return out.buffer;
}

export function decodeText(buffer: ArrayBuffer): string {
  return decoder.decode(buffer);
}

export const prefixSuffixDiffer: Differ = {
  algorithm: "prefix-suffix",
  compute(previous: string, next: string): Diff[] {
    if (previous === next) return [];

    // Trim the shared prefix and suffix so a single edit becomes one delete and/or insert.
    let start = 0;
    const prevLength = previous.length;
    const nextLength = next.length;

    while (
      start < prevLength &&
      start < nextLength &&
      previous[start] === next[start]
    ) {
      start += 1;
    }

    let prevEnd = prevLength - 1;
    let nextEnd = nextLength - 1;

    while (
      prevEnd >= start &&
      nextEnd >= start &&
      previous[prevEnd] === next[nextEnd]
    ) {
      prevEnd -= 1;
      nextEnd -= 1;
    }

    const removed = previous.slice(start, prevEnd + 1);
    const added = next.slice(start, nextEnd + 1);

    const diffs: Diff[] = [];

    if (removed.length) {
      diffs.push({
        op: DiffOp.DELETE,
        data: encodeText(removed),
        range: { start, end: start + removed.length },
      });
    }

    if (added.length) {
      diffs.push({
        op: DiffOp.INSERT,
        data: encodeText(added),
        range: { start, end: start },
      });
    }

    return diffs;
  },
};

const DEFAULT_MAX_DP_CELLS = 40_000;

const commonBounds = (
  previous: string,
  next: string,
): {
  prefixLength: number;
  previousMiddle: string;
  nextMiddle: string;
  previousEnd: number;
  nextEnd: number;
} => {
  let prefixLength = 0;

  while (
    prefixLength < previous.length &&
    prefixLength < next.length &&
    previous[prefixLength] === next[prefixLength]
  ) {
    prefixLength += 1;
  }

  let previousEnd = previous.length - 1;
  let nextEnd = next.length - 1;

  while (
    previousEnd >= prefixLength &&
    nextEnd >= prefixLength &&
    previous[previousEnd] === next[nextEnd]
  ) {
    previousEnd -= 1;
    nextEnd -= 1;
  }

  return {
    prefixLength,
    previousMiddle: previous.slice(prefixLength, previousEnd + 1),
    nextMiddle: next.slice(prefixLength, nextEnd + 1),
    previousEnd,
    nextEnd,
  };
};

export const lcsDpDiffer: Differ = {
  algorithm: "lcs-dp",
  compute(previous: string, next: string, options?: DiffOptions): Diff[] {
    if (previous === next) return [];

    const {
      prefixLength,
      previousMiddle,
      nextMiddle,
    } = commonBounds(previous, next);

    if (!previousMiddle.length || !nextMiddle.length) {
      return prefixSuffixDiffer.compute(previous, next);
    }

    const maxCells = options?.maxDpCells ?? DEFAULT_MAX_DP_CELLS;
    const cellCount = previousMiddle.length * nextMiddle.length;

    if (cellCount > maxCells) {
      return prefixSuffixDiffer.compute(previous, next);
    }

    const rows = previousMiddle.length + 1;
    const cols = nextMiddle.length + 1;
    const table = new Uint32Array(rows * cols);

    const index = (row: number, col: number): number => row * cols + col;

    for (let row = previousMiddle.length - 1; row >= 0; row -= 1) {
      for (let col = nextMiddle.length - 1; col >= 0; col -= 1) {
        table[index(row, col)] =
          previousMiddle[row] === nextMiddle[col]
            ? table[index(row + 1, col + 1)] + 1
            : Math.max(table[index(row + 1, col)], table[index(row, col + 1)]);
      }
    }

    const diffs: Diff[] = [];
    let previousCursor = 0;
    let nextCursor = 0;
    let currentPosition = prefixLength;

    while (
      previousCursor < previousMiddle.length ||
      nextCursor < nextMiddle.length
    ) {
      if (
        previousCursor < previousMiddle.length &&
        nextCursor < nextMiddle.length &&
        previousMiddle[previousCursor] === nextMiddle[nextCursor]
      ) {
        previousCursor += 1;
        nextCursor += 1;
        currentPosition += 1;
        continue;
      }

      let deleted = "";
      let inserted = "";
      const hunkStart = currentPosition;

      while (
        previousCursor < previousMiddle.length ||
        nextCursor < nextMiddle.length
      ) {
        if (
          previousCursor < previousMiddle.length &&
          nextCursor < nextMiddle.length &&
          previousMiddle[previousCursor] === nextMiddle[nextCursor]
        ) {
          break;
        }

        const deleteScore =
          previousCursor < previousMiddle.length
            ? table[index(previousCursor + 1, nextCursor)]
            : -1;

        const insertScore =
          nextCursor < nextMiddle.length
            ? table[index(previousCursor, nextCursor + 1)]
            : -1;

        if (nextCursor >= nextMiddle.length || deleteScore >= insertScore) {
          deleted += previousMiddle[previousCursor];
          previousCursor += 1;
        } else {
          inserted += nextMiddle[nextCursor];
          nextCursor += 1;
        }
      }

      if (deleted.length) {
        diffs.push({
          op: DiffOp.DELETE,
          data: encodeText(deleted),
          range: { start: hunkStart, end: hunkStart + deleted.length },
        });
      }

      if (inserted.length) {
        diffs.push({
          op: DiffOp.INSERT,
          data: encodeText(inserted),
          range: { start: hunkStart, end: hunkStart },
        });
        currentPosition = hunkStart + inserted.length;
      }
    }

    return diffs;
  },
};

export function getDiffer(algorithm: DiffAlgorithm = "prefix-suffix"): Differ {
  if (algorithm === "prefix-suffix") return prefixSuffixDiffer;
  if (algorithm === "lcs-dp") return lcsDpDiffer;

  const exhaustive: never = algorithm;
  throw new Error(`Unsupported diff algorithm: ${exhaustive}`);
}

export function computeDiffOps(
  previous: string,
  next: string,
  options: DiffOptions = {},
): Diff[] {
  return getDiffer(options.algorithm).compute(previous, next, options);
}

export function applyDiff(previous: string, diff: Diff): string {
  const range = diff.range ?? { start: 0, end: 0 };
  const start = Math.max(0, Math.min(range.start, previous.length));
  const end = Math.max(start, Math.min(range.end, previous.length));

  // All callers rely on range clamping so stale or replayed diffs fail soft instead of throwing.
  if (diff.op === DiffOp.INSERT) {
    const inserted = decodeText(diff.data);
    return previous.slice(0, start) + inserted + previous.slice(start);
  }

  if (diff.op === DiffOp.DELETE) {
    return previous.slice(0, start) + previous.slice(end);
  }

  return previous;
}

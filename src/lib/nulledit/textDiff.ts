import { DiffOp, type Diff } from "./types";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeText(value: string): ArrayBuffer {
  return encoder.encode(value).buffer;
}

export function decodeText(buffer: ArrayBuffer): string {
  return decoder.decode(buffer);
}

export function computeDiffOps(previous: string, next: string): Diff[] {
  if (previous === next) return [];

  let start = 0;
  const prevLength = previous.length;
  const nextLength = next.length;

  while (start < prevLength && start < nextLength && previous[start] === next[start]) {
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
}

export function applyDiff(previous: string, diff: Diff): string {
  const range = diff.range ?? { start: 0, end: 0 };
  const start = Math.max(0, Math.min(range.start, previous.length));
  const end = Math.max(start, Math.min(range.end, previous.length));

  if (diff.op === DiffOp.INSERT) {
    const inserted = decodeText(diff.data);
    return previous.slice(0, start) + inserted + previous.slice(start);
  }

  if (diff.op === DiffOp.DELETE) {
    return previous.slice(0, start) + previous.slice(end);
  }

  return previous;
}

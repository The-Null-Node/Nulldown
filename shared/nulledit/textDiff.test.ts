import {
  applyDiff,
  computeDiffOps,
  getDiffer,
  lcsDpDiffer,
  prefixSuffixDiffer,
} from "./textDiff";
import {
  diffToDropDiffOp,
  dropDiffOpToDiff,
} from "../drop/diff";
import { DiffOp, type Diff } from "./types";

const applyAll = (base: string, diffs: Diff[]): string =>
  diffs.reduce((text, diff) => applyDiff(text, diff), base);

describe("computeDiffOps default behavior", () => {
  it("keeps prefix-suffix as the default algorithm", () => {
    const previous = "alpha beta gamma";
    const next = "alpha BETA gamma";

    const diffs = computeDiffOps(previous, next);

    expect(applyAll(previous, diffs)).toBe(next);
    expect(diffs.length).toBe(2);
    expect(diffs[0].op).toBe(DiffOp.DELETE);
    expect(diffs[1].op).toBe(DiffOp.INSERT);
  });

  it("returns empty array for identical strings", () => {
    expect(computeDiffOps("same", "same")).toEqual([]);
  });

  it("handles pure insertion at start", () => {
    const diffs = computeDiffOps("world", "hello world");
    expect(applyAll("world", diffs)).toBe("hello world");
  });

  it("handles pure deletion at end", () => {
    const diffs = computeDiffOps("hello world", "hello");
    expect(applyAll("hello world", diffs)).toBe("hello");
  });
});

describe("getDiffer selector", () => {
  it("returns prefixSuffixDiffer for prefix-suffix", () => {
    const differ = getDiffer("prefix-suffix");
    expect(differ).toBe(prefixSuffixDiffer);
    expect(differ.algorithm).toBe("prefix-suffix");
  });

  it("returns lcsDpDiffer for lcs-dp", () => {
    const differ = getDiffer("lcs-dp");
    expect(differ).toBe(lcsDpDiffer);
    expect(differ.algorithm).toBe("lcs-dp");
  });

  it("throws for unsupported algorithm", () => {
    expect(() => getDiffer("myers" as any)).toThrow("Unsupported diff algorithm");
  });
});

describe("prefixSuffixDiffer direct usage", () => {
  it("computes diffs that apply cleanly through applyDiff", () => {
    const previous = "one two three four";
    const next = "one TWO three FOUR";

    const diffs = prefixSuffixDiffer.compute(previous, next);
    const result = applyAll(previous, diffs);

    expect(result).toBe(next);
  });

  it("handles ascii text with special characters", () => {
    const previous = "hello @#$%^&*() world";
    const next = "hello WORLD @#$%^&*()";

    const diffs = prefixSuffixDiffer.compute(previous, next);
    const result = applyAll(previous, diffs);

    expect(result).toBe(next);
  });
});

describe("lcsDpDiffer", () => {
  it("handles multi-region changes that prefix-suffix can't model compactly", () => {
    const previous = "one two three four";
    const next = "one TWO three FOUR";

    const diffs = lcsDpDiffer.compute(previous, next);

    expect(applyAll(previous, diffs)).toBe(next);
    // LCS should identify " three " as shared, producing 4 ops
    expect(diffs.length).toBeGreaterThanOrEqual(2);
  });

  it("applies cleanly for single-region change", () => {
    const previous = "hello world";
    const next = "hello WORLD";

    const diffs = lcsDpDiffer.compute(previous, next);

    expect(applyAll(previous, diffs)).toBe(next);
  });

  it("returns empty for identical strings", () => {
    expect(lcsDpDiffer.compute("same", "same")).toEqual([]);
  });

  it("falls back to prefix-suffix when cell budget exceeded", () => {
    const previous = "a".repeat(300) + "x" + "b".repeat(300);
    const next = "a".repeat(300) + "y" + "b".repeat(300);

    const diffs = lcsDpDiffer.compute(previous, next, { maxDpCells: 1 });

    expect(applyAll(previous, diffs)).toBe(next);
    expect(diffs).toEqual(
      prefixSuffixDiffer.compute(previous, next),
    );
  });

  it("handles pure insertion", () => {
    const previous = "abc";
    const next = "abcXYZdef";

    const diffs = lcsDpDiffer.compute(previous, next);
    expect(applyAll(previous, diffs)).toBe(next);
  });

  it("handles pure deletion", () => {
    const previous = "abcXYZdef";
    const next = "abcdef";

    const diffs = lcsDpDiffer.compute(previous, next);
    expect(applyAll(previous, diffs)).toBe(next);
  });

  it("round-trips through DropDiffOp wire format", () => {
    const previous = "one two three four";
    const next = "one TWO three FOUR";

    const ops = lcsDpDiffer.compute(previous, next).map((diff) =>
      diffToDropDiffOp(diff),
    );

    const restored = ops
      .map((op) => dropDiffOpToDiff(op))
      .filter((diff): diff is Diff => Boolean(diff))
      .reduce((text, diff) => applyDiff(text, diff), previous);

    expect(restored).toBe(next);
  });
});

describe("computeDiffOps with algorithm option", () => {
  it("uses lcs-dp when requested", () => {
    const previous = "one two three four";
    const next = "one TWO three FOUR";

    const diffs = computeDiffOps(previous, next, { algorithm: "lcs-dp" });

    expect(applyAll(previous, diffs)).toBe(next);
  });

  it("uses prefix-suffix when explicit", () => {
    const previous = "alpha beta gamma";
    const next = "alpha BETA gamma";

    const diffs = computeDiffOps(previous, next, {
      algorithm: "prefix-suffix",
    });

    expect(diffs.length).toBe(2);
    expect(diffs[0].op).toBe(DiffOp.DELETE);
    expect(diffs[1].op).toBe(DiffOp.INSERT);
    expect(applyAll(previous, diffs)).toBe(next);
  });
});

import { describe, it, expect } from "@jest/globals";
import type { BranchStateContent } from "../../../shared/drop/branch-state";
import { ExactContentCache } from "./exact-content-cache";
import { initialQuery, referenceVersion } from "./testing/commit-contract";

const value = (id: number, content = "🧪漢字"): BranchStateContent => ({
  ...initialQuery(),
  version: referenceVersion(id, content),
  content,
});
const query = (v: BranchStateContent) => ({
  target: v.target,
  placement: v.placement,
  version: v.version,
});
function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("bounded exact-version disposable cache", () => {
  it("LRU capacity is bounded and source/return mutations do not change entries", () => {
    const cache = new ExactContentCache({ maxEntries: 2, maxBytes: 100_000 });
    const one = value(1),
      two = value(2),
      three = value(3);
    cache.set(one);
    cache.set(two);
    const hit = cache.get(query(one))!;
    hit.content = "mutated";
    hit.version.snapshotId = 999;
    one.content = "caller changed";
    expect(cache.get(query(value(1)))?.content).toBe("🧪漢字");
    cache.set(three);
    expect(cache.get(query(two))).toBeUndefined();
    expect(cache.stats().entries).toBe(2);
    expect(cache.get(query(value(1)))?.content).toBe("🧪漢字");
  });
  it("byte cap evicts, oversized Unicode bypasses storage, and disabled cache remains empty", () => {
    const cache = new ExactContentCache({ maxEntries: 50, maxBytes: 1400 });
    for (let id = 0; id < 100; id++) {
      cache.set(value(id, "🧪".repeat(80)));
      expect(cache.stats().bytes).toBeLessThanOrEqual(1400);
    }
    expect(cache.stats().entries).toBeLessThan(50);
    const oversized = value(101, "🧪".repeat(400));
    cache.set(oversized);
    expect(cache.get(query(oversized))).toBeUndefined();
    const disabled = new ExactContentCache({ maxEntries: 0, maxBytes: 0 });
    disabled.set(value(1));
    expect(disabled.stats()).toEqual({ entries: 0, bytes: 0, inFlight: 0 });
    cache.clear();
    expect(cache.stats()).toEqual({ entries: 0, bytes: 0, inFlight: 0 });
  });
  it("coalesces exact loads, returns independent copies, and clears failed flights for retry", async () => {
    const cache = new ExactContentCache({
        maxEntries: 2,
        maxBytes: 10_000,
        maxInFlight: 1,
      }),
      pending = deferred<BranchStateContent>(),
      v = value(1);
    let calls = 0;
    const loader = () => {
      calls++;
      return pending.promise;
    };
    const a = cache.load(query(v), loader),
      b = cache.load(query(v), loader);
    expect(calls).toBe(1);
    expect(cache.stats().inFlight).toBe(1);
    pending.resolve(v);
    const [first, second] = await Promise.all([a, b]);
    first.content = "changed";
    expect(second.content).toBe(v.content);
    expect(cache.stats().inFlight).toBe(0);
    const bad = value(2);
    await expect(
      cache.load(query(bad), async () => {
        throw Error("load failed");
      }),
    ).rejects.toThrow("load failed");
    expect(cache.stats().inFlight).toBe(0);
    expect(await cache.load(query(bad), async () => bad)).toEqual(bad);
  });
  it("bounded in-flight saturation does not queue unbounded bookkeeping", async () => {
    const cache = new ExactContentCache({
        maxEntries: 1,
        maxBytes: 10_000,
        maxInFlight: 1,
      }),
      a = deferred<BranchStateContent>(),
      b = deferred<BranchStateContent>();
    const one = cache.load(query(value(1)), () => a.promise),
      two = cache.load(query(value(2)), () => b.promise);
    expect(cache.stats().inFlight).toBe(1);
    a.resolve(value(1));
    b.resolve(value(2));
    await Promise.all([one, two]);
    expect(cache.stats().inFlight).toBe(0);
    expect(cache.stats().entries).toBe(1);
  });
  it("all version/placement/branch dimensions isolate keys and wrong loader identities fail closed", async () => {
    const cache = new ExactContentCache(),
      v = value(1);
    cache.set(v);
    const variants = [
      { ...v, target: { ...v.target, branchId: "another" } },
      { ...v, placement: { ...v.placement, generation: 8 } },
      { ...v, version: { ...v.version, eventSeq: 99 } },
      { ...v, version: referenceVersion(1, "wrong hash") },
      { ...v, version: { ...v.version, snapshotId: 2 } },
    ];
    for (const changed of variants) {
      expect(cache.get(query(changed))).toBeUndefined();
      await expect(cache.load(query(changed), async () => v)).rejects.toThrow(
        "state_corrupt",
      );
      expect(cache.stats().inFlight).toBe(0);
    }
    const empty = value(0, "");
    cache.set(empty);
    expect(cache.get(query(empty))?.content).toBe("");
  });
  it("rejects invalid budget inputs", () => {
    for (const invalid of [-1, Infinity, NaN, 1.5])
      expect(
        () => new ExactContentCache({ maxEntries: invalid, maxBytes: 10 }),
      ).toThrow(RangeError);
  });
});

import {
  BranchStateError,
  BranchStateQuery,
  type BranchContentQuery,
  type BranchStateContent,
} from "../../../shared/drop/branch-state";

/** Per-owner disposable cache budgets, including bounded concurrent reconstruction bookkeeping. */
export interface ExactContentCacheOptions {
  maxEntries: number;
  maxBytes: number;
  maxInFlight?: number;
}

/** Bounded LRU for exact immutable content only. The caller must verify durable placement and identity on every read. */
export class ExactContentCache {
  private readonly entries = new Map<
    string,
    { value: BranchStateContent; bytes: number }
  >();
  private readonly pending = new Map<string, Promise<BranchStateContent>>();
  private usedBytes = 0;
  private readonly options: Required<ExactContentCacheOptions>;

  constructor(
    options: ExactContentCacheOptions = {
      maxEntries: 64,
      maxBytes: 4 * 1024 * 1024,
    },
  ) {
    this.options = { ...options, maxInFlight: options.maxInFlight ?? 32 };
    for (const value of Object.values(this.options)) {
      if (!Number.isSafeInteger(value) || value < 0)
        throw new RangeError("Invalid cache budget");
    }
  }

  /** Copies an exact-key hit and refreshes its LRU position; empty content remains a hit. */
  get(query: BranchContentQuery): BranchStateContent | undefined {
    const key = BranchStateQuery.key("content", query);
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return structuredClone(entry.value);
  }

  /** Stores a defensive copy if it fits; accounts for keys, identity and UTF-8 content, not just entry count. */
  set(value: BranchStateContent): void {
    const query = BranchStateQuery.content({
      target: value.target,
      placement: value.placement,
      version: value.version,
    });
    if (typeof value.content !== "string")
      throw new BranchStateError("state_corrupt");
    const key = BranchStateQuery.key("content", query);
    const copy = { ...query, content: value.content };
    const bytes =
      new TextEncoder().encode(key).byteLength +
      new TextEncoder().encode(JSON.stringify(copy)).byteLength;
    const old = this.entries.get(key);
    if (old) {
      this.usedBytes -= old.bytes;
      this.entries.delete(key);
    }
    if (this.options.maxEntries === 0 || bytes > this.options.maxBytes) return;
    while (
      this.entries.size >= this.options.maxEntries ||
      this.usedBytes + bytes > this.options.maxBytes
    ) {
      const first = this.entries.keys().next().value;
      if (first === undefined) break;
      this.usedBytes -= this.entries.get(first)!.bytes;
      this.entries.delete(first);
    }
    this.entries.set(key, { value: copy, bytes });
    this.usedBytes += bytes;
  }

  /** Coalesces bounded exact-key loads. Saturation bypasses bookkeeping rather than accumulating an unbounded queue. */
  async load(
    query: BranchContentQuery,
    loader: () => Promise<BranchStateContent>,
  ): Promise<BranchStateContent> {
    const captured = BranchStateQuery.content(query);
    const key = BranchStateQuery.key("content", captured);
    const hit = this.get(captured);
    if (hit) return hit;
    const existing = this.pending.get(key);
    if (existing) return structuredClone(await existing);
    const promise = (async () => {
      const value = await loader();
      if (
        BranchStateQuery.key("content", {
          target: value.target,
          placement: value.placement,
          version: value.version,
        }) !== key
      ) {
        throw new BranchStateError("state_corrupt");
      }
      this.set(value);
      return value;
    })();
    const tracked = this.pending.size < this.options.maxInFlight;
    if (tracked) this.pending.set(key, promise);
    try {
      return structuredClone(await promise);
    } finally {
      if (tracked && this.pending.get(key) === promise)
        this.pending.delete(key);
    }
  }

  /** Evicts disposable content; in-flight callers still receive their immutable version. */
  clear(): void {
    this.entries.clear();
    this.usedBytes = 0;
  }

  /** Content-free budget diagnostics for independent verification. */
  stats(): { entries: number; bytes: number; inFlight: number } {
    return {
      entries: this.entries.size,
      bytes: this.usedBytes,
      inFlight: this.pending.size,
    };
  }
}

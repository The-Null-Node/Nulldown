import {
  heapifyResolvedDocument,
  queryResolvedDocumentNodes,
} from "../shared/drop/resolved";

const parseSizes = (): number[] => {
  const sizes = process.argv.slice(2).map(Number).filter(Number.isFinite);
  return sizes.length ? sizes : [1, 5, 10];
};

const iterations = Math.max(
  1,
  Number.parseInt(process.env.BENCH_ITERATIONS ?? "3", 10) || 3,
);

const median = (values: readonly number[]): number => {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)];
};

const createMarkdown = (megabytes: number): string => {
  const unit = [
    "# Performance Plan",
    "",
    "## Slice",
    "Paragraph with [reference](https://nulldown.app/d/example) and searchable content.",
    "- [ ] Open task",
    "```nd(id=child-drop-1)",
    "```",
    "",
  ].join("\n");
  const targetBytes = megabytes * 1024 * 1024;
  const chunks: string[] = [];
  let size = 0;
  while (size < targetBytes) {
    chunks.push(unit);
    size += unit.length;
  }
  return chunks.join("");
};

const run = async (): Promise<void> => {
  await heapifyResolvedDocument({
    rootDropId: "benchmark-warmup",
    content: createMarkdown(0.05),
  });

  for (const megabytes of parseSizes()) {
    const content = createMarkdown(megabytes);
    const heapifyElapsedMs: number[] = [];
    const queryElapsedMs: number[] = [];
    let nodeCount = 0;
    let resultCount = 0;

    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const heapifyStartedAt = performance.now();
      const state = await heapifyResolvedDocument({
        rootDropId: "benchmark-root",
        branchId: "benchmark",
        content,
      });
      heapifyElapsedMs.push(performance.now() - heapifyStartedAt);
      const queryStartedAt = performance.now();
      const changedRanges = Array.from({ length: 200 }, (_, index) => {
        const start = Math.floor((content.length / 200) * index);
        return { start, end: start + 24 };
      });
      const results = queryResolvedDocumentNodes(state, {
        q: "searchable content",
        changedRanges,
        limit: 10,
      });
      queryElapsedMs.push(performance.now() - queryStartedAt);
      nodeCount = state.documentNodes?.length ?? 0;
      resultCount = results.length;
    }

    console.log(
      JSON.stringify({
        megabytes,
        iterations,
        bytes: content.length,
        nodeCount,
        heapifyMedianMs: Number(median(heapifyElapsedMs).toFixed(2)),
        queryMedianMs: Number(median(queryElapsedMs).toFixed(2)),
        resultCount,
      }),
    );
  }
};

void run();

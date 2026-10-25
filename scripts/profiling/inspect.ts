/** Offline strict-schema inspector; emits only validated tracing metadata. */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { MAX_BYTES, validBatch } from "../../shared/observability/profiling";
import { waterfall } from "./waterfall";
const bytes = readFileSync(process.argv[2]);
if (bytes.length > MAX_BYTES) throw new Error("Batch exceeds limit");
const batch: unknown = JSON.parse(bytes.toString("utf8"));
if (!validBatch(batch) || batch.version !== 2)
  throw new Error("Expected validated v2 batch");
const output = {
  summary: batch.summary,
  waterfall: waterfall(batch),
  timing:
    "inclusive wall milliseconds; exclusive unknown when incomplete; Workers timer may quantize CPU phases to0ms",
};
writeFileSync(
  resolve(import.meta.dir, "../../.profiling/inspection.json"),
  JSON.stringify(output, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    records: batch.events.length,
    detailDropped: batch.summary.detailDropped,
    detailTruncated: batch.summary.detailTruncated,
    complete: output.waterfall.every((e) => e.complete),
  }),
);

import { runCli } from "../../src/cli";
import { createMemoryVoidDataStore } from "../../src/server/memoryDataStore";
import type {
  VoidDataPutRecord,
  VoidDataStore,
} from "../../src/server/ports";
import { RESOLVED_DOCUMENT_RESOLVER_ID } from "../../shared/drop/resolved/constants";

const isResolvedDocumentProjection = (records: VoidDataPutRecord[]): boolean => {
  const heap = records[0]?.key;
  return (
    heap?.namespace === "resolved" &&
    heap.collection === "heaps" &&
    heap.id === RESOLVED_DOCUMENT_RESOLVER_ID
  );
};

const backing = createMemoryVoidDataStore();
let armed = true;

const data: VoidDataStore = {
  ...backing,
  async putMany(records) {
    if (armed && isResolvedDocumentProjection(records)) {
      armed = false;
      throw new Error("test_fault:resolved_document_put_many_once");
    }
    await backing.putMany(records);
  },
};

const result = await runCli(process.argv.slice(2), { serve: { data } });
process.exitCode = result.exitCode;

import type { BranchMemoryService } from "../runtime";
import type { BranchMemoryStatePlane } from "./contracts";

/** Adapts a request-lifetime memory service without changing ranking, freshness, or persistence. */
export const createLegacyMemoryStatePlane = (
  memory: BranchMemoryService,
): BranchMemoryStatePlane => ({
  memory: {
    query: (request) => memory.query(request),
    createFact: (request) => memory.createFact(request),
    createProcedure: (request) => memory.createProcedure(request),
    delete: (request) => memory.delete(request),
  },
});

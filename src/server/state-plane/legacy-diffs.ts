import { createBranchDiffRepository } from "../../../functions/api/_lib/branches/storage/diff-log";
import { createBranchRuntimeFactLogRepository } from "../../../functions/api/_lib/branches/storage/runtime-fact-log";
import type { BlobObjectStore, SqlMetadataStore } from "../ports";
import type { BranchDiffCommands, BranchDiffPolling } from "./contracts";

/** Wraps an injected request-lifetime command service without replacing its locks or receipts. */
export const createLegacyBranchDiffCommands = (
  commands: BranchDiffCommands,
): BranchDiffCommands => ({
  appendDiffEvents: (request) => commands.appendDiffEvents(request),
});

/** Creates request-scoped polling over the existing event and runtime-fact services. */
export const createLegacyBranchDiffPolling = (
  blobs: BlobObjectStore,
  sql?: SqlMetadataStore,
): BranchDiffPolling => ({
  async poll({
    rootDropId,
    branch,
    cursor,
    excludeClient,
    limit,
    factCursor,
    factLimit,
  }) {
    const { branchId } = branch;
    const diffs = createBranchDiffRepository({ blobs, sql });
    const facts = createBranchRuntimeFactLogRepository({ blobs, sql });
    if (cursor === "__latest__") {
      const [maxSeq, maxFactSeq] = await Promise.all([
        typeof branch.headEventSeq === "number"
          ? branch.headEventSeq
          : diffs.readBranchHeadEventSeq(rootDropId, branchId),
        factCursor !== undefined
          ? facts.readBranchHeadRuntimeFactSeq(rootDropId, branchId)
          : Promise.resolve(-1),
      ]);
      return {
        response: {
          events: [],
          cursor: maxSeq >= 0 ? String(maxSeq) : null,
          ...(factCursor !== undefined
            ? { facts: [], factCursor: String(maxFactSeq) }
            : {}),
        },
        totalStored: maxSeq + 1,
        totalFacts: maxFactSeq + 1,
      };
    }

    const pagePromise = diffs.pollBranchDiffEventsSince(
      rootDropId,
      branchId,
      cursor !== null ? Number.parseInt(cursor, 10) : -1,
      limit,
      excludeClient,
    );
    const factsPromise =
      factCursor === undefined
        ? Promise.resolve(null)
        : factCursor === "__latest__"
          ? facts
              .readBranchHeadRuntimeFactSeq(rootDropId, branchId)
              .then((headSeq) => ({
                facts: [],
                nextCursor: headSeq,
                headSeq,
              }))
          : facts.pollBranchRuntimeFactsSince(
              rootDropId,
              branchId,
              Number.parseInt(factCursor, 10),
              factLimit,
            );
    const [page, factPage] = await Promise.all([pagePromise, factsPromise]);
    return {
      response: {
        events: page.events,
        cursor: page.nextCursor !== null ? String(page.nextCursor) : null,
        ...(factPage
          ? {
              facts: factPage.facts,
              factCursor:
                factPage.nextCursor !== null
                  ? String(factPage.nextCursor)
                  : null,
            }
          : {}),
      },
      totalStored: page.headSeq + 1,
      totalFacts: factPage ? factPage.headSeq + 1 : undefined,
    };
  },
});

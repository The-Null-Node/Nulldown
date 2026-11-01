import {
  captureNullMemJson,
  validateNullMemQueryResult,
  validateNullMemPutResult,
  validateNullMemDeleteResult,
  type BranchNullMemStatePlane,
} from "../../../shared/drop/branch-nullmem";
import {
  BranchStateError,
  BranchStateQuery,
  type BranchStateHead,
} from "../../../shared/drop/branch-state";
import { createBuiltInNullMemCapabilities } from "../../../shared/nullmem/capabilities/built-ins";
import { createThemeCatalogCapabilityRecords } from "../../../shared/nullmem/capabilities/theme";
import { evaluateNullMemFreshnessBatch } from "../../../shared/nullmem/freshness";
import type {
  NullMemFactRecord,
  NullMemProcedureRecord,
  NullMemRecord,
} from "../../../shared/nullmem/records";
import { isNullMemRecord } from "../../../shared/nullmem/validation";
import { createNullMemQuery } from "../../../functions/api/_lib/nullmem/query";
import { createNullMemMutationService } from "../../../functions/api/_lib/nullmem/mutation";
import type { BranchMemoryService } from "../runtime";
import type { LocalBranchApplicationSelection } from "./commit-application";

/** Explicit request-time source for additional sensitive catalog records, never branch-memory fallback. */
export interface LocalNullMemCatalog {
  readRecords(options: {
    kind?: NullMemRecord["kind"];
    canReadSensitive: boolean;
  }): Promise<NullMemRecord[]>;
}

/** Local branch memory dependencies; global persisted defaults require separate explicit authority. */
export interface LocalBranchNullMemSelection {
  backend: BranchNullMemStatePlane;
  catalog?: LocalNullMemCatalog;
}

/** Trusted request authorization, resolved before constructing the local memory service. */
export interface LocalNullMemAccess {
  actorAccountId: string | null;
  canReadSensitive: boolean;
}

const unsupported = async (): Promise<never> => {
  throw new BranchStateError("capability_unsupported");
};

/** Composes one authorized request's memory operations over selected durable authority and explicit catalogs. */
export function createLocalNullMemService(
  selection: LocalBranchApplicationSelection,
  access: LocalNullMemAccess,
): BranchMemoryService {
  const selected = selection.nullmem;
  if (selection.mode !== "local-test" || !selected)
    throw new BranchStateError("capability_unsupported");
  const { backend, catalog } = selected;
  const queryFor = async (rootDropId: string, branchId: string) => {
    const target = { rootDropId, branchId };
    return BranchStateQuery.head({
      target,
      placement: selection.lifecycle
        ? await selection.lifecycle.requireActivePlacement(target)
        : selection.placement,
    });
  };
  const put = async (record: NullMemRecord) => {
    if (!access.actorAccountId) throw new BranchStateError("forbidden");
    if (record.kind !== "fact" && record.kind !== "procedure")
      throw new BranchStateError("invalid_command");
    // The legacy mutation builder represents omitted optional fields as undefined; capture the JSON wire value.
    const captured = JSON.parse(captureNullMemJson(record)) as
      NullMemFactRecord | NullMemProcedureRecord;
    const query = await queryFor(captured.rootDropId!, captured.branchId!);
    const command = {
      ...structuredClone(query),
      actorAccountId: access.actorAccountId,
      record: structuredClone(captured),
    };
    const result = await backend.putNullMem(structuredClone(command));
    validateNullMemPutResult(result, command);
    return result.record;
  };
  return {
    async query(input) {
      const request = structuredClone(input);
      if (!access.canReadSensitive)
        request.labels = [
          ...new Set([...(request.labels ?? []), "public-memory"]),
        ];
      const query = await queryFor(request.rootDropId, request.branchId);
      let head: BranchStateHead | undefined;
      const read = createNullMemQuery({
        repository: {
          async readRecords(_root, _branch, options) {
            const limit = Math.max(
              1,
              Math.min(100, Math.floor(request.limit ?? 20)),
            );
            const selection = {
              ...structuredClone(query),
              kind: options?.kind,
              q: request.q,
              labels: request.labels,
              procedureId: request.procedureId || undefined,
              limit,
            };
            const result = await backend.queryNullMem(
              structuredClone(selection),
            );
            validateNullMemQueryResult(result, selection);
            head = structuredClone(result.head);
            return result.records;
          },
          writeRecord: unsupported,
          deleteRecord: unsupported,
        },
        catalog: {
          async readRecords({ kind } = {}) {
            const builtIns =
              kind && kind !== "capability"
                ? []
                : [
                    ...createBuiltInNullMemCapabilities(0),
                    ...createThemeCatalogCapabilityRecords(0),
                  ];
            const additional =
              access.canReadSensitive && catalog
                ? await catalog.readRecords({ kind, canReadSensitive: true })
                : [];
            if (
              additional.some(
                (record) =>
                  !isNullMemRecord(record) ||
                  (record.kind !== "capability" &&
                    ((record.rootDropId &&
                      record.rootDropId !== request.rootDropId) ||
                      (record.branchId &&
                        record.branchId !== request.branchId))),
              )
            )
              throw new BranchStateError("state_corrupt");
            return [
              ...builtIns,
              ...additional.filter((record) => !kind || record.kind === kind),
            ];
          },
        },
        freshness: {
          async evaluate({ records }) {
            if (!head) throw new BranchStateError("state_corrupt");
            return evaluateNullMemFreshnessBatch({
              records,
              currentSnapshotId: head.version.snapshotId,
            }).reports;
          },
        },
      });
      return read(request);
    },
    async createFact(input) {
      const request = structuredClone(input);
      let stored: NullMemFactRecord | undefined;
      const mutations = createNullMemMutationService({
        readRecords: unsupported,
        deleteRecord: unsupported,
        async writeRecord(record) {
          stored = (await put(record)) as NullMemFactRecord;
        },
      });
      const result = await mutations.createFact(request);
      if (!stored) throw new BranchStateError("state_corrupt");
      return { ...result, record: stored };
    },
    async createProcedure(input) {
      const request = structuredClone(input);
      let stored: NullMemProcedureRecord | undefined;
      const mutations = createNullMemMutationService({
        readRecords: unsupported,
        deleteRecord: unsupported,
        async writeRecord(record) {
          stored = (await put(record)) as NullMemProcedureRecord;
        },
      });
      const result = await mutations.createProcedure(request);
      if (!stored) throw new BranchStateError("state_corrupt");
      return { ...result, record: stored };
    },
    async delete(input) {
      const request = structuredClone(input);
      if (!access.actorAccountId) throw new BranchStateError("forbidden");
      const query = await queryFor(request.rootDropId, request.branchId);
      const command = {
        ...structuredClone(query),
        actorAccountId: access.actorAccountId,
        recordId: request.recordId,
      };
      const result = await backend.deleteNullMem(structuredClone(command));
      validateNullMemDeleteResult(result, command);
      return request;
    },
  };
}

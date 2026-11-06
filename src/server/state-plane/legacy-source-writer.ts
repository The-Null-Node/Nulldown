import {
  BranchStateError,
  BranchStateQuery,
  type BranchStateTarget,
} from "../../../shared/drop/branch-state";
import type { SourceWritePermit } from "./source-fence";

/** Request-lifetime port to the durable source admission ledger; synchronous local adapters are supported. */
export interface SourceWriterAdmission {
  admit(
    permit: SourceWritePermit,
  ): SourceWritePermit | Promise<SourceWritePermit>;
  complete(permit: SourceWritePermit): void | Promise<void>;
}

/** Bounded domain name for one admitted legacy mutation. */
export type SourceMutationKind =
  "document" | "runtime-fact" | "memory" | "lifecycle" | "maintenance";

/** Content-free outcome for a single server-generated admission identity. */
export interface SourceWriterEvent {
  event: "source.writer";
  version: 1;
  requestId: string;
  operation: SourceMutationKind;
  generation: number;
  outcome: "admitted" | "completed" | "rejected" | "uncertain";
  reason:
    | "permit_acquired"
    | "writes_settled"
    | "scope_mismatch"
    | "admission_rejected"
    | "admission_unavailable"
    | "operation_failed"
    | "background_failed"
    | "completion_unconfirmed";
}

/** Tracks every deferred source write belonging to one admitted operation. */
export interface SourceMutationWork {
  /** Same-scope nested operations share this already-admitted lifetime, including during drain. */
  writer: LegacySourceWriter;
  /** Registers background work before the operation settles; nested registration is drained too. */
  waitUntil(promise: Promise<unknown>): void;
  /** Keeps the durable admission unresolved when a lower layer catches an uncertain write failure. */
  markUncertain(): void;
}

/** Explicit request-owned writer capability for one branch and one captured source generation. */
export interface LegacySourceWriter {
  run<T>(
    target: BranchStateTarget,
    operation: SourceMutationKind,
    work: (context: SourceMutationWork) => Promise<T>,
  ): Promise<T>;
}

/**
 * Composes an exact-scope source writer for one request. The caller must register
 * the durable gate before branch creation and route every source mutation through
 * this capability. Success releases admission only after deferred work settles.
 * Failed/unknown operations retain their permits for explicit reconciliation;
 * neither elapsed time nor a client retry releases an uncertain writer.
 */
export function createLegacySourceWriter(options: {
  target: BranchStateTarget;
  generation: number;
  admission: SourceWriterAdmission;
  observe?: (event: SourceWriterEvent) => void | Promise<void>;
}): LegacySourceWriter {
  const selected = BranchStateQuery.head({
    target: options.target,
    placement: { routingVersion: 1, generation: options.generation },
  });
  const { admission, observe } = options;
  return {
    async run(target, operation, work) {
      const requestId = crypto.randomUUID();
      const report = (
        outcome: SourceWriterEvent["outcome"],
        reason: SourceWriterEvent["reason"],
      ) => {
        try {
          const result = observe?.({
            event: "source.writer",
            version: 1,
            requestId,
            operation,
            generation: selected.placement.generation,
            outcome,
            reason,
          });
          if (result) void Promise.resolve(result).catch(() => undefined);
        } catch {
          // Observability cannot authorize or interrupt a writer.
        }
      };
      if (
        target.rootDropId !== selected.target.rootDropId ||
        target.branchId !== selected.target.branchId
      ) {
        report("rejected", "scope_mismatch");
        throw new BranchStateError("routing_placement_mismatch");
      }
      const permit: SourceWritePermit = {
        target: structuredClone(selected.target),
        generation: selected.placement.generation,
        requestId,
      };
      let accepted: SourceWritePermit;
      try {
        accepted = await admission.admit(structuredClone(permit));
      } catch (error) {
        const rejected =
          error instanceof BranchStateError &&
          [
            "routing_placement_mismatch",
            "invalid_command",
            "branch_not_found",
          ].includes(error.code);
        report(
          rejected ? "rejected" : "uncertain",
          rejected ? "admission_rejected" : "admission_unavailable",
        );
        throw error instanceof BranchStateError
          ? error
          : new BranchStateError("state_unavailable");
      }
      if (
        !accepted ||
        accepted.target?.rootDropId !== permit.target.rootDropId ||
        accepted.target?.branchId !== permit.target.branchId ||
        accepted.generation !== permit.generation ||
        accepted.requestId !== requestId
      ) {
        report("uncertain", "admission_unavailable");
        throw new BranchStateError("state_corrupt");
      }
      report("admitted", "permit_acquired");
      const pending: Promise<void>[] = [];
      let uncertain = false;
      let closed = false;
      const context: SourceMutationWork = {
        writer: {
          run(nestedTarget, _operation, nestedWork) {
            if (
              closed ||
              nestedTarget.rootDropId !== permit.target.rootDropId ||
              nestedTarget.branchId !== permit.target.branchId
            ) {
              uncertain = true;
              return Promise.reject(
                new BranchStateError("routing_placement_mismatch"),
              );
            }
            const task = Promise.resolve().then(() => nestedWork(context));
            context.waitUntil(task);
            return task;
          },
        },
        waitUntil(task) {
          if (closed) throw new BranchStateError("invalid_command");
          pending.push(
            Promise.resolve(task).then(
              () => undefined,
              () => {
                uncertain = true;
              },
            ),
          );
        },
        markUncertain() {
          uncertain = true;
        },
      };
      let result: Awaited<ReturnType<typeof work>>;
      let failed = false;
      let failure: unknown;
      try {
        result = await work(context);
      } catch (error) {
        failed = true;
        failure = error;
      }
      // A tracked task can enqueue another tracked task while settling.
      for (let cursor = 0; cursor < pending.length; cursor++)
        await pending[cursor];
      closed = true;
      if (failed || uncertain) {
        report("uncertain", failed ? "operation_failed" : "background_failed");
        if (failed) throw failure;
        throw new BranchStateError("state_unavailable");
      }
      try {
        await admission.complete(structuredClone(permit));
      } catch {
        report("uncertain", "completion_unconfirmed");
        throw new BranchStateError("state_unavailable");
      }
      report("completed", "writes_settled");
      return result!;
    },
  };
}

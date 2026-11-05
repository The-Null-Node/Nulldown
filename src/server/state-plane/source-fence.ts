import {
  BranchStateError,
  BranchStateQuery,
  type BranchStateTarget,
} from "../../../shared/drop/branch-state";
import type { BranchSqlPort } from "./sqlite-port";

/** Persistent source-writer admission state for one explicitly gated branch. */
export interface SourceFenceState {
  target: BranchStateTarget;
  generation: number;
  phase: "legacy" | "draining" | "frozen" | "transferred";
  migrationId: string | null;
  active: number;
}

/** One durable admission; completion is safe only after every source mutation has settled. */
export interface SourceWritePermit {
  target: BranchStateTarget;
  generation: number;
  requestId: string;
}

/** A drained source generation, held closed until abort or irreversible transfer. */
export interface SourceFenceCertificate {
  target: BranchStateTarget;
  sourceGeneration: number;
  migrationId: string;
}

const token = (value: string): string => {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > 256 ||
    value.trim() !== value
  )
    throw new BranchStateError("invalid_command");
  return value;
};
const capture = (target: BranchStateTarget, generation: number) =>
  BranchStateQuery.head({
    target,
    placement: { routingVersion: 1, generation },
  });
const scope = (target: BranchStateTarget) => [
  JSON.stringify(target.rootDropId),
  JSON.stringify(target.branchId),
];

/**
 * Connection-scoped durable admission ledger for isolated migration sources.
 * Every source mutation must enter this gate from branch creation onward. It does
 * not retrofit fencing onto writers that bypass it. Uncertain/crashed admissions
 * never expire: migration remains blocked until their outcomes are reconciled.
 */
export class SqliteSourceWriteFence {
  constructor(private readonly sql: BranchSqlPort) {
    sql.transaction(() => {
      sql.execute(`CREATE TABLE IF NOT EXISTS migration_source_gate (
        root TEXT NOT NULL, branch TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation>=0),
        phase TEXT NOT NULL CHECK(phase IN ('legacy','draining','frozen','transferred')),
        migration_id TEXT, active INTEGER NOT NULL DEFAULT 0 CHECK(active>=0), PRIMARY KEY(root,branch))`);
      sql.execute(`CREATE TABLE IF NOT EXISTS migration_source_permit (
        root TEXT NOT NULL, branch TEXT NOT NULL, generation INTEGER NOT NULL, request_id TEXT NOT NULL,
        completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN (0,1)), PRIMARY KEY(root,branch,generation,request_id))`);
    });
  }

  /** Creates admission state explicitly, preserving any prior fence on repeated registration. */
  register(target: BranchStateTarget): SourceFenceState {
    const { target: value } = capture(target, 0);
    return this.sql.transaction(() => {
      this.sql.execute(
        "INSERT INTO migration_source_gate(root,branch,generation,phase) VALUES(?,?,0,'legacy') ON CONFLICT(root,branch) DO NOTHING",
        ...scope(value),
      );
      return this.read(value);
    });
  }

  /** Reads one exact scope; absent admission state never implicitly authorizes writes. */
  read(target: BranchStateTarget): SourceFenceState {
    const { target: value } = capture(target, 0);
    const row = this.sql.rows(
      "SELECT generation,phase,migration_id,active FROM migration_source_gate WHERE root=? AND branch=?",
      ...scope(value),
    )[0];
    if (!row) throw new BranchStateError("branch_not_found");
    if (
      !Number.isSafeInteger(row.generation) ||
      Number(row.generation) < 0 ||
      !Number.isSafeInteger(row.active) ||
      Number(row.active) < 0 ||
      !["legacy", "draining", "frozen", "transferred"].includes(
        String(row.phase),
      ) ||
      (row.phase !== "legacy" && typeof row.migration_id !== "string")
    )
      throw new BranchStateError("state_corrupt");
    return {
      target: value,
      generation: Number(row.generation),
      phase: row.phase as SourceFenceState["phase"],
      migrationId: row.migration_id as string | null,
      active: Number(row.active),
    };
  }

  /** Allocates a single-use durable writer admission under the exact live generation. */
  admit(input: SourceWritePermit): SourceWritePermit {
    const { target } = capture(input.target, input.generation);
    const requestId = token(input.requestId);
    return this.sql.transaction(() => {
      const state = this.read(target);
      if (state.generation !== input.generation || state.phase !== "legacy")
        throw new BranchStateError("routing_placement_mismatch");
      if (
        this.sql.rows(
          "SELECT completed FROM migration_source_permit WHERE root=? AND branch=? AND generation=? AND request_id=?",
          ...scope(target),
          input.generation,
          requestId,
        ).length
      )
        throw new BranchStateError("invalid_command");
      this.sql.execute(
        "INSERT INTO migration_source_permit(root,branch,generation,request_id) VALUES(?,?,?,?)",
        ...scope(target),
        input.generation,
        requestId,
      );
      this.sql.execute(
        "UPDATE migration_source_gate SET active=active+1 WHERE root=? AND branch=?",
        ...scope(target),
      );
      return { target, generation: input.generation, requestId };
    });
  }

  /** Marks a settled writer once; a lost completion acknowledgement is safely retryable. */
  complete(input: SourceWritePermit): void {
    const { target } = capture(input.target, input.generation);
    const requestId = token(input.requestId);
    this.sql.transaction(() => {
      const row = this.sql.rows(
        "SELECT completed FROM migration_source_permit WHERE root=? AND branch=? AND generation=? AND request_id=?",
        ...scope(target),
        input.generation,
        requestId,
      )[0];
      if (!row) throw new BranchStateError("invalid_command");
      if (row.completed === 1) return;
      const state = this.read(target);
      if (
        state.generation !== input.generation ||
        state.active < 1 ||
        !["legacy", "draining"].includes(state.phase)
      )
        throw new BranchStateError("state_corrupt");
      this.sql.execute(
        "UPDATE migration_source_permit SET completed=1 WHERE root=? AND branch=? AND generation=? AND request_id=?",
        ...scope(target),
        input.generation,
        requestId,
      );
      this.sql.execute(
        "UPDATE migration_source_gate SET active=active-1 WHERE root=? AND branch=?",
        ...scope(target),
      );
    });
  }

  /** Closes admissions before draining; repeated calls advance to frozen only when active reaches zero. */
  fence(input: SourceFenceCertificate): SourceFenceState {
    const { target } = capture(input.target, input.sourceGeneration);
    const migrationId = token(input.migrationId);
    return this.sql.transaction(() => {
      const state = this.read(target);
      if (
        state.generation !== input.sourceGeneration ||
        (state.migrationId && state.migrationId !== migrationId) ||
        state.phase === "transferred"
      )
        throw new BranchStateError("routing_placement_mismatch");
      this.sql.execute(
        "UPDATE migration_source_gate SET phase=?,migration_id=? WHERE root=? AND branch=?",
        state.active === 0 ? "frozen" : "draining",
        migrationId,
        ...scope(target),
      );
      return this.read(target);
    });
  }

  /** Verifies the source remains drained and closed before export, comparison, or transfer. */
  assertFrozen(input: SourceFenceCertificate): void {
    const { target } = capture(input.target, input.sourceGeneration);
    const migrationId = token(input.migrationId);
    const state = this.read(target);
    if (
      state.generation !== input.sourceGeneration ||
      state.migrationId !== migrationId ||
      state.phase !== "frozen" ||
      state.active !== 0
    )
      throw new BranchStateError("routing_placement_mismatch");
  }

  /**
   * Irreversibly retires source writes BEFORE destination activation is attempted.
   * Lost activation responses recover forward; this state has no routing-flip rollback.
   */
  transfer(input: SourceFenceCertificate): void {
    this.sql.transaction(() => {
      const state = this.read(input.target);
      if (
        state.phase === "transferred" &&
        state.generation === input.sourceGeneration &&
        state.migrationId === input.migrationId
      )
        return;
      this.assertFrozen(input);
      this.sql.execute(
        "UPDATE migration_source_gate SET phase='transferred' WHERE root=? AND branch=?",
        ...scope(input.target),
      );
    });
  }

  /** Reopens a pre-transfer source with a new generation after the caller durably aborts the destination import. */
  abort(input: SourceFenceCertificate): SourceFenceState {
    return this.sql.transaction(() => {
      this.assertFrozen(input);
      if (!Number.isSafeInteger(input.sourceGeneration + 1))
        throw new BranchStateError("invalid_command");
      this.sql.execute(
        "UPDATE migration_source_gate SET phase='legacy',generation=generation+1,migration_id=NULL WHERE root=? AND branch=?",
        ...scope(input.target),
      );
      return this.read(input.target);
    });
  }
}

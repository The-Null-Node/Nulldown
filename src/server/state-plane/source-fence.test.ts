import { describe, expect, it } from "@jest/globals";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteSourceWriteFence } from "./source-fence";
import { LocalBranchSqlite } from "./local-sqlite";
import { observeBranchSql } from "./sqlite-port";

const target = { rootDropId: "migration-source", branchId: "owner" };
const certificate = { target, sourceGeneration: 0, migrationId: "migration-1" };

describe("durable migration source admission", () => {
  it("drains admitted writes, rejects new and stale writers, and retires source before target activation", () => {
    const sql = new LocalBranchSqlite();
    try {
      const gate = new SqliteSourceWriteFence(sql);
      expect(() =>
        gate.admit({ target, generation: 0, requestId: "missing" }),
      ).toThrow();
      gate.register(target);
      const permit = gate.admit({
        target,
        generation: 0,
        requestId: "in-flight",
      });
      expect(gate.fence(certificate)).toMatchObject({
        phase: "draining",
        active: 1,
      });
      expect(() => gate.assertFrozen(certificate)).toThrow();
      expect(() =>
        gate.admit({ target, generation: 0, requestId: "late" }),
      ).toThrow();
      expect(() => gate.transfer(certificate)).toThrow();
      gate.complete(permit);
      gate.complete(permit);
      expect(gate.fence(certificate)).toMatchObject({
        phase: "frozen",
        active: 0,
      });
      gate.transfer(certificate);
      gate.transfer(certificate);
      expect(() => gate.abort(certificate)).toThrow();
      expect(() =>
        gate.admit({ target, generation: 0, requestId: "old-writer" }),
      ).toThrow();
      expect(gate.register(target).phase).toBe("transferred");
    } finally {
      sql.close();
    }
  });

  it("preserves uncertain admissions across reopen instead of expiring them into unsafe cutover", () => {
    const directory = mkdtempSync(join(tmpdir(), "migration-fence-"));
    const path = join(directory, "state.sqlite");
    let sql = new LocalBranchSqlite(path);
    try {
      let gate = new SqliteSourceWriteFence(sql);
      gate.register(target);
      const permit = gate.admit({
        target,
        generation: 0,
        requestId: "crashed",
      });
      gate.fence(certificate);
      sql.close();
      sql = new LocalBranchSqlite(path);
      gate = new SqliteSourceWriteFence(sql);
      expect(gate.fence(certificate)).toMatchObject({
        phase: "draining",
        active: 1,
      });
      expect(() => gate.complete({ ...permit, requestId: "forged" })).toThrow();
      expect(() =>
        gate.fence({ ...certificate, migrationId: "other" }),
      ).toThrow();
      // Only the reconciled original writer can settle the outstanding admission.
      gate.complete(permit);
      gate.fence(certificate);
      expect(gate.abort(certificate)).toMatchObject({
        phase: "legacy",
        generation: 1,
      });
      expect(() =>
        gate.admit({ target, generation: 0, requestId: "stale" }),
      ).toThrow();
      const fresh = gate.admit({ target, generation: 1, requestId: "fresh" });
      gate.complete(fresh);
      expect(() => gate.admit(fresh)).toThrow();
    } finally {
      sql.close();
      rmSync(directory, { recursive: true });
    }
  });

  it("rolls back admission and completion atomically at every mutation cut", () => {
    for (const cut of [1, 2, 3, 4]) {
      const sql = new LocalBranchSqlite();
      let armed = false,
        seen = 0;
      const gate = new SqliteSourceWriteFence(
        observeBranchSql(sql, (event) => {
          if (armed && event.operation === "execute" && ++seen === cut)
            throw Error("injected");
        }),
      );
      try {
        gate.register(target);
        armed = true;
        expect(() =>
          gate.admit({ target, generation: 0, requestId: "atomic" }),
        ).toThrow("injected");
        armed = false;
        expect(gate.read(target).active).toBe(0);
        const permit = gate.admit({
          target,
          generation: 0,
          requestId: "atomic",
        });
        seen = 0;
        armed = true;
        expect(() => gate.complete(permit)).toThrow("injected");
        armed = false;
        expect(gate.read(target).active).toBe(1);
        gate.complete(permit);
        expect(gate.read(target).active).toBe(0);
      } finally {
        sql.close();
      }
    }
  });
});

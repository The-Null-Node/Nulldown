import { describe, expect, it } from "@jest/globals";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashNulldownSourceContent } from "../../../shared/drop/resolved/hash";
import {
  SqliteBranchAuthorityControl,
  captureAuthoritySelection,
} from "./authority-control";
import { LocalBranchSqlite } from "./local-sqlite";
import { SqliteBranchCommitStatePlane } from "./sqlite-commits";
import type { CapturedLegacyBranch } from "./legacy-migration-source";
import { selectBranchApplication } from "./gateway";
import type { BranchSqlPort } from "./sqlite-port";
import { createCommitApplicationStatePlane } from "./commit-application";

const target = { rootDropId: "AuthorityRoot001", branchId: "owner" };
const certificate = {
  target,
  sourceGeneration: 0,
  migrationId: "authority-migration-1",
};
const permit = { target, generation: 0, requestId: "writer-1" };

async function capture(): Promise<CapturedLegacyBranch> {
  const contentHash = await hashNulldownSourceContent("");
  const branch = {
    version: 1 as const,
    ...target,
    baseDropId: target.rootDropId,
    mode: "owner" as const,
    status: "active" as const,
    ownerAccountId: "owner-account",
    writerAccountId: "owner-account",
    writerClientId: null,
    headSnapshotId: 0,
    headEventSeq: -1,
    snapshotHeapVersion: 2,
    checkpointInterval: 24,
    createdAt: 1,
    updatedAt: 1,
  };
  return {
    branch,
    branchEtag: "etag-1",
    captureHash: contentHash,
    snapshots: [
      {
        content: "",
        contentHash,
        snapshot: {
          version: 1,
          ...target,
          snapshotId: 0,
          parentSnapshotId: null,
          seq: 0,
          eventIds: [],
          checkpointed: true,
          patchStartSeq: null,
          patchEndSeq: null,
          textLength: 0,
          createdAt: 1,
          sourceContentHash: contentHash,
        },
      },
    ],
    events: [],
    runtimeFacts: [],
    memoryRecords: [],
  };
}

function fixture(path?: string) {
  const sql = new LocalBranchSqlite(path);
  const plane = new SqliteBranchCommitStatePlane(sql);
  const control = new SqliteBranchAuthorityControl(sql);
  return { sql, plane, control };
}

describe("durable authority control", () => {
  it("preserves legacy snapshot metadata while querying through its verified version hash", async () => {
    const { sql, control, plane } = fixture();
    try {
      const source = await capture();
      delete source.snapshots[0].snapshot.sourceContentHash;
      source.snapshots[0].snapshot.checkpointKey = "legacy-checkpoint";
      control.register(target);
      control.freeze(certificate);
      await control.prepare(certificate, async () => source);
      await control.importChunk(certificate, 0);
      await control.verify(certificate);
      await control.activate(certificate);
      const app = createCommitApplicationStatePlane({
        mode: "local-test",
        commits: plane,
        history: plane,
        placement: { routingVersion: 1, generation: 1 },
        resolvedQuery: true,
      });
      expect(
        await app.snapshots.listSnapshotsForBranch(
          target.rootDropId,
          target.branchId,
        ),
      ).toEqual([source.snapshots[0].snapshot]);
      const result = await app.resolvedQuery!.queryDocument({
        ...target,
        snapshotId: 0,
      });
      expect(result.sourceContentHash).toBe(source.snapshots[0].contentHash);
      expect(result.stale).toBe(false);
    } finally {
      sql.close();
    }
  });

  it("rejects recycled and cross-branch migration identities before closing admission", () => {
    const { sql, control } = fixture();
    try {
      const other = { ...target, branchId: "other" };
      control.register(target);
      control.register(other);
      control.freeze(certificate);
      expect(() => control.freeze({ ...certificate, target: other })).toThrow(
        "branch_initialization_conflict",
      );
      expect(control.source(other).phase).toBe("legacy");
      control.abort(certificate);
      expect(() =>
        control.freeze({ ...certificate, sourceGeneration: 1 }),
      ).toThrow("branch_initialization_conflict");
      expect(control.source(target).phase).toBe("legacy");
      expect(() =>
        control.freeze({
          ...certificate,
          sourceGeneration: 1,
          migrationId: "bad/id",
        }),
      ).toThrow("invalid_command");
    } finally {
      sql.close();
    }
  });

  it("atomically rolls back source reopening and import cleanup when abort receipt persistence fails", async () => {
    const sql = new LocalBranchSqlite();
    new SqliteBranchCommitStatePlane(sql);
    let failReceipt = false;
    const connection: BranchSqlPort = {
      rows: (statement, ...bindings) => sql.rows(statement, ...bindings),
      transaction: (work) => sql.transaction(work),
      execute(statement, ...bindings) {
        if (
          failReceipt &&
          statement.startsWith("INSERT INTO branch_migration_aborts")
        )
          throw Error("receipt_write_failed");
        sql.execute(statement, ...bindings);
      },
    };
    const control = new SqliteBranchAuthorityControl(connection);
    try {
      control.register(target);
      control.freeze(certificate);
      await control.prepare(certificate, capture);
      const progress = await control.importChunk(certificate, 0);
      failReceipt = true;
      expect(() => control.abort(certificate)).toThrow("receipt_write_failed");
      expect(control.source(target)).toMatchObject({
        phase: "frozen",
        generation: 0,
      });
      expect(control.progress(certificate)).toEqual(progress);
      failReceipt = false;
      expect(control.abort(certificate)).toMatchObject({
        phase: "rolled-back",
      });
    } finally {
      sql.close();
    }
  });

  it("rejects orphan destination state instead of admitting a legacy writer", () => {
    const { sql, control } = fixture();
    try {
      control.register(target);
      sql.execute(
        "INSERT INTO branch_authorities(root_drop_id,branch_id,authority_json) VALUES(?,?,?)",
        JSON.stringify(target.rootDropId),
        JSON.stringify(target.branchId),
        "{}",
      );
      expect(() => control.select(target)).toThrow("state_corrupt");
      expect(() => control.admit(permit)).toThrow("state_corrupt");
      expect(control.source(target).active).toBe(0);
    } finally {
      sql.close();
    }
  });

  it("revalidates transfer after asynchronous preparation races with abort", async () => {
    const { sql, control } = fixture();
    try {
      control.register(target);
      control.freeze(certificate);
      await control.prepare(certificate, capture);
      await control.importChunk(certificate, 0);
      await control.verify(certificate);
      const pending = control.transfer(certificate);
      control.abort(certificate);
      await expect(pending).rejects.toThrow();
      expect(control.select(target)).toMatchObject({
        backend: "legacy",
        placement: { generation: 1 },
      });
      expect(control.progress(certificate).phase).toBe("rolled-back");
    } finally {
      sql.close();
    }
  });

  it("never constructs a legacy writer when destination selection is unavailable or transitional", async () => {
    let admitted = false;
    for (const mode of ["unavailable", "transition"] as const) {
      await expect(
        selectBranchApplication({
          target,
          authority: {
            async select() {
              if (mode === "unavailable")
                throw Error("destination_unavailable");
              return {
                target,
                backend: "transition",
                placement: { routingVersion: 1, generation: 0 },
                sourcePhase: "transferred",
                migrationId: certificate.migrationId,
              };
            },
            async admit(value) {
              admitted = true;
              return value;
            },
            async complete() {},
          },
          destination() {
            throw Error("must not construct destination");
          },
        }),
      ).rejects.toThrow(
        mode === "unavailable"
          ? "destination_unavailable"
          : "branch_initialization_pending",
      );
    }
    expect(admitted).toBe(false);
  });

  it("does not enroll missing branches and drains admitted lifetimes before capture", async () => {
    const { sql, control } = fixture();
    try {
      expect(() => control.select(target)).toThrow("branch_not_found");
      control.register(target);
      control.admit(permit);
      expect(control.freeze(certificate)).toMatchObject({
        phase: "draining",
        active: 1,
      });
      expect(() => control.admit({ ...permit, requestId: "writer-2" })).toThrow(
        "routing_placement_mismatch",
      );
      await expect(control.prepare(certificate, capture)).rejects.toThrow(
        "routing_placement_mismatch",
      );
      expect(control.source(target).active).toBe(1);
      control.complete(permit);
      control.complete(permit);
      expect(control.freeze(certificate)).toMatchObject({
        phase: "frozen",
        active: 0,
      });
      expect(() => control.assertBootstrapAllowed(target)).toThrow(
        "routing_placement_mismatch",
      );
    } finally {
      sql.close();
    }
  });

  it("reopens after transfer with no legacy fallback, then activates and returns exact retries", async () => {
    const directory = mkdtempSync(join(tmpdir(), "authority-control-"));
    const path = join(directory, "branch.sqlite");
    let f = fixture(path);
    try {
      f.control.register(target);
      f.control.freeze(certificate);
      const prepared = await f.control.prepare(certificate, capture);
      expect(
        await f.control.prepare(certificate, async () => {
          throw Error("must not recapture");
        }),
      ).toEqual(prepared);
      await f.control.importChunk(certificate, 0);
      await f.control.verify(certificate);
      await f.control.transfer(certificate);
      expect(f.control.select(target).backend).toBe("transition");
      expect((await f.control.verify(certificate)).phase).toBe("verified");
      expect(() => f.control.abort(certificate)).toThrow(
        "routing_placement_mismatch",
      );
      f.sql.close();
      f = fixture(path);
      expect(f.control.select(target).backend).toBe("transition");
      expect(() => f.control.admit(permit)).toThrow(
        "routing_placement_mismatch",
      );
      await f.control.transfer(certificate);
      const activated = await f.control.activate(certificate);
      expect(await f.control.activate(certificate)).toEqual(activated);
      expect(f.control.select(target)).toMatchObject({
        backend: "state-plane",
        placement: { generation: 1 },
      });
      expect(
        (
          await f.plane.readHead({
            target,
            placement: { routingVersion: 1, generation: 1 },
          })
        ).version.snapshotId,
      ).toBe(0);
      expect(f.control.register(target).phase).toBe("transferred");
    } finally {
      f.sql.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("aborts an unprepared frozen source exactly once, including after another migration starts", () => {
    const { sql, control } = fixture();
    try {
      control.register(target);
      control.freeze(certificate);
      const receipt = control.abort(certificate);
      expect(receipt).toMatchObject({ phase: "legacy", generation: 1 });
      expect(() => control.admit(permit)).toThrow("routing_placement_mismatch");
      const next = {
        ...certificate,
        sourceGeneration: 1,
        migrationId: "next-migration",
      };
      control.freeze(next);
      expect(control.abort(certificate)).toEqual(receipt);
      expect(control.source(target)).toMatchObject({
        phase: "frozen",
        generation: 1,
        migrationId: "next-migration",
      });
    } finally {
      sql.close();
    }
  });

  it("rejects capture completion after an abort changed the source generation", async () => {
    const { sql, control } = fixture();
    try {
      control.register(target);
      control.freeze(certificate);
      await expect(
        control.prepare(certificate, async () => {
          const source = await capture();
          control.abort(certificate);
          return source;
        }),
      ).rejects.toThrow("routing_placement_mismatch");
      expect(() => control.progress(certificate)).toThrow("branch_not_found");
      expect(control.select(target)).toMatchObject({
        backend: "legacy",
        placement: { generation: 1 },
      });
    } finally {
      sql.close();
    }
  });

  it("rolls back capture records when admission fails and rejects cross-target migration retries", async () => {
    const { sql, control } = fixture();
    try {
      control.register(target);
      control.freeze(certificate);
      await expect(
        control.prepare(certificate, async () => ({
          ...(await capture()),
          branch: { ...(await capture()).branch, branchId: "other" },
        })),
      ).rejects.toThrow("routing_placement_mismatch");
      expect(() => control.progress(certificate)).toThrow("branch_not_found");
      await control.prepare(certificate, capture);
      expect(() =>
        control.progress({
          ...certificate,
          target: { ...target, branchId: "other" },
        }),
      ).toThrow("routing_placement_mismatch");
      const receipt = control.abort(certificate);
      expect(receipt).toMatchObject({ phase: "rolled-back", generation: 1 });
      expect(control.abort(certificate)).toEqual(receipt);
      await expect(control.importChunk(certificate, 0)).rejects.toThrow(
        "routing_placement_mismatch",
      );
    } finally {
      sql.close();
    }
  });

  it("rejects malformed authority responses instead of selecting legacy", () => {
    expect(() =>
      captureAuthoritySelection(
        {
          target,
          backend: "legacy",
          placement: { routingVersion: 1, generation: 0 },
          sourcePhase: "transferred",
          migrationId: "m",
        },
        target,
      ),
    ).toThrow("state_corrupt");
  });

  it("rechecks delayed source reads and never runs source work after freeze", async () => {
    const { sql, control } = fixture();
    try {
      control.register(target);
      const request = await selectBranchApplication({
        target,
        authority: {
          select: async (value) => control.select(value),
          admit: async (value) => control.admit(value),
          complete: async (value) => control.complete(value),
        },
        destination() {
          throw Error("unexpected destination");
        },
      });
      control.freeze(certificate);
      let ran = false;
      await expect(
        request.legacySourceWriter!.run(target, "document", async () => {
          ran = true;
        }),
      ).rejects.toThrow("routing_placement_mismatch");
      expect(ran).toBe(false);
      await request.validateRead(); // frozen source is still the readable authority
      control.abort(certificate);
      await expect(request.validateRead()).rejects.toThrow(
        "routing_placement_mismatch",
      );
    } finally {
      sql.close();
    }
  });
});

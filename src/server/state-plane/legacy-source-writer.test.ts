import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { BranchStateError } from "../../../shared/drop/branch-state";
import { LocalBranchSqlite } from "./local-sqlite";
import { SqliteSourceWriteFence, type SourceWritePermit } from "./source-fence";
import {
  createLegacySourceWriter,
  type LegacySourceWriter,
  type SourceWriterEvent,
} from "./legacy-source-writer";

const target = { rootDropId: "source-writer-test", branchId: "owner" };
const certificate = {
  target,
  sourceGeneration: 0,
  migrationId: "writer-migration",
};
const connections: LocalBranchSqlite[] = [];
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const fixture = () => {
  const sql = new LocalBranchSqlite();
  connections.push(sql);
  const gate = new SqliteSourceWriteFence(sql);
  gate.register(target);
  const events: SourceWriterEvent[] = [];
  const writer = createLegacySourceWriter({
    target,
    generation: 0,
    admission: gate,
    observe: (event) => {
      events.push(event);
    },
  });
  return { sql, gate, writer, events };
};
afterEach(() => {
  for (const sql of connections.splice(0)) sql.close();
});

describe("request-owned legacy source admission", () => {
  it("closes new admissions while nested and deferred source writes drain under the original permit", async () => {
    const { gate, writer, events } = fixture();
    const entered = deferred();
    const resume = deferred();
    const nestedFinished = deferred();
    let nested: LegacySourceWriter | undefined;
    const task = writer.run(target, "document", async (work) => {
      nested = work.writer;
      work.waitUntil(
        resume.promise.then(async () => {
          await work.writer.run(target, "memory", async (inner) => {
            inner.waitUntil(nestedFinished.promise);
          });
        }),
      );
      entered.resolve();
      return "accepted";
    });
    await entered.promise;
    expect(gate.fence(certificate)).toMatchObject({
      phase: "draining",
      active: 1,
    });
    const bypass = jest.fn(async () => undefined);
    await expect(writer.run(target, "memory", bypass)).rejects.toMatchObject({
      code: "routing_placement_mismatch",
    });
    expect(bypass).not.toHaveBeenCalled();
    resume.resolve();
    await Promise.resolve();
    expect(gate.fence(certificate)).toMatchObject({
      phase: "draining",
      active: 1,
    });
    nestedFinished.resolve();
    await expect(task).resolves.toBe("accepted");
    expect(gate.fence(certificate)).toMatchObject({
      phase: "frozen",
      active: 0,
    });
    expect(events.filter((event) => event.outcome === "admitted")).toHaveLength(
      1,
    );
    await expect(nested!.run(target, "memory", bypass)).rejects.toMatchObject({
      code: "routing_placement_mismatch",
    });
    expect(bypass).not.toHaveBeenCalled();
  });

  it.each(["operation", "deferred", "swallowed", "nested"] as const)(
    "retains an uncertain %s failure even after retry succeeds",
    async (kind) => {
      const { gate, writer, events } = fixture();
      await expect(
        writer.run(target, "document", async (work) => {
          if (kind === "operation") throw Error("partial write");
          if (kind === "deferred")
            work.waitUntil(Promise.reject(Error("partial deferred write")));
          if (kind === "swallowed") work.markUncertain();
          if (kind === "nested")
            await work.writer
              .run(target, "memory", async () => {
                throw Error("partial memory");
              })
              .catch(() => undefined);
        }),
      ).rejects.toThrow();
      await writer.run(target, "document", async () => undefined);
      expect(gate.fence(certificate)).toMatchObject({
        active: 1,
        phase: "draining",
      });
      expect(events.some((event) => event.outcome === "uncertain")).toBe(true);
    },
  );

  it("retains a lost admission acknowledgement and never invokes source work", async () => {
    const { gate } = fixture();
    let permit!: SourceWritePermit;
    const work = jest.fn(async () => undefined);
    const writer = createLegacySourceWriter({
      target,
      generation: 0,
      admission: {
        admit(value) {
          permit = gate.admit(value);
          throw Error("response lost");
        },
        complete: (value) => gate.complete(value),
      },
    });
    await expect(writer.run(target, "document", work)).rejects.toMatchObject({
      code: "state_unavailable",
    });
    expect(work).not.toHaveBeenCalled();
    expect(gate.fence(certificate)).toMatchObject({
      active: 1,
      phase: "draining",
    });
    // Explicit reconciliation proves this request never entered its work callback.
    gate.complete(permit);
    expect(gate.fence(certificate)).toMatchObject({
      active: 0,
      phase: "frozen",
    });
  });

  it.each([false, true])(
    "handles lost completion acknowledgement (persisted=%s) without rerunning work",
    async (persisted) => {
      const { gate } = fixture();
      let permit!: SourceWritePermit;
      const work = jest.fn(async () => "done");
      const writer = createLegacySourceWriter({
        target,
        generation: 0,
        admission: {
          admit: (value) => gate.admit(value),
          complete(value) {
            permit = value;
            if (persisted) gate.complete(value);
            throw Error("response lost");
          },
        },
      });
      await expect(writer.run(target, "document", work)).rejects.toMatchObject({
        code: "state_unavailable",
      });
      expect(work).toHaveBeenCalledTimes(1);
      expect(gate.read(target).active).toBe(persisted ? 0 : 1);
      // All writes settled before complete was invoked; replaying that completion is safe.
      gate.complete(permit);
      gate.complete(permit);
      expect(gate.fence(certificate)).toMatchObject({
        active: 0,
        phase: "frozen",
      });
    },
  );

  it("rejects absent gates, other branches and stale generations before source work", async () => {
    const { gate, writer } = fixture();
    const work = jest.fn(async () => undefined);
    const absentTarget = { ...target, branchId: "unregistered" };
    await expect(
      createLegacySourceWriter({
        target: absentTarget,
        generation: 0,
        admission: gate,
      }).run(absentTarget, "lifecycle", work),
    ).rejects.toMatchObject({ code: "branch_not_found" });
    await expect(
      writer.run(absentTarget, "lifecycle", work),
    ).rejects.toMatchObject({ code: "routing_placement_mismatch" });
    gate.fence(certificate);
    gate.abort(certificate);
    await expect(writer.run(target, "document", work)).rejects.toMatchObject({
      code: "routing_placement_mismatch",
    });
    expect(work).not.toHaveBeenCalled();
    await createLegacySourceWriter({
      target,
      generation: 1,
      admission: gate,
    }).run(target, "document", work);
    expect(work).toHaveBeenCalledTimes(1);
    expect(gate.read(target)).toMatchObject({ generation: 1, active: 0 });
  });

  it("treats an invalid admitted permit as uncertain and isolates telemetry failure", async () => {
    const { gate } = fixture();
    const events: SourceWriterEvent[] = [];
    const work = jest.fn(async () => undefined);
    const writer = createLegacySourceWriter({
      target,
      generation: 0,
      admission: {
        admit(value) {
          return { ...gate.admit(value), requestId: "wrong-response" };
        },
        complete: (value) => gate.complete(value),
      },
      observe(event) {
        events.push(event);
        throw Error("telemetry unavailable");
      },
    });
    await expect(writer.run(target, "document", work)).rejects.toBeInstanceOf(
      BranchStateError,
    );
    expect(work).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({
      outcome: "uncertain",
      reason: "admission_unavailable",
    });
    expect(gate.fence(certificate)).toMatchObject({
      active: 1,
      phase: "draining",
    });
    const other = { ...target, branchId: "other" };
    gate.register(other);
    await createLegacySourceWriter({
      target: other,
      generation: 0,
      admission: gate,
      observe: async () => {
        throw Error("telemetry unavailable");
      },
    }).run(other, "memory", work);
    expect(gate.read(other).active).toBe(0);
  });
});

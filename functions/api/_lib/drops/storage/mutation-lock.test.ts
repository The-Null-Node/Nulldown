import { jest } from "@jest/globals";
import { MemoryR2Bucket } from "../testing/storage-fixture";
import { acquireRootMutationLock } from "./mutation-lock";

describe("root mutation lock contracts", () => {
  it("serializes protected root writers and deleters through one root lease", async () => {
    const bucket = new MemoryR2Bucket();
    const first = await acquireRootMutationLock(
      bucket as never,
      "DeleteLock004",
    );
    let acquiredSecond = false;
    const secondPromise = acquireRootMutationLock(
      bucket as never,
      "DeleteLock004",
    ).then((lock) => {
      acquiredSecond = true;
      return lock;
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(acquiredSecond).toBe(false);

    await first.release();
    const second = await secondPromise;
    expect(acquiredSecond).toBe(true);
    await second.release();
  });

  it("rejects a stale root mutation after another actor takes over its lease", async () => {
    const bucket = new MemoryR2Bucket();
    const now = Date.now();
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(now);
    const first = await acquireRootMutationLock(
      bucket as never,
      "DeleteLock005",
    );
    nowSpy.mockReturnValue(now + 300_001);
    const second = await acquireRootMutationLock(
      bucket as never,
      "DeleteLock005",
    );

    await expect(first.beginCommit()).rejects.toMatchObject({
      code: "root_mutation_lock_lost",
    });
    nowSpy.mockRestore();
    await first.release();
    await second.release();
  });
});

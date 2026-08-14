import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jest } from "@jest/globals";
import {
  BranchMutationLockError,
  withBranchMutationLock,
} from "../functions/api/_lib/branches/storage/mutationLock";
import { createBranchLockKey } from "../functions/api/_lib/branches/storage/keys";
import { createFilesystemBlobStore } from "./server/filesystemBlobStore";
import type { VoidBlobStore } from "./server/ports";

describe("branch mutation lock", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "nulldown-branch-lock-"));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("serializes overlapping branch mutations", async () => {
    const store = createFilesystemBlobStore({ rootDir });
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted: (() => void) | undefined;
    const firstHasStarted = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });

    const first = withBranchMutationLock(store, "root-1", "branch-1", async (lock) => {
      await lock.beginCommit();
      order.push("first-start");
      firstStarted?.();
      await firstMayFinish;
      order.push("first-end");
    });
    await firstHasStarted;
    const second = withBranchMutationLock(store, "root-1", "branch-1", async (lock) => {
      await lock.beginCommit();
      order.push("second");
    });

    releaseFirst?.();
    await Promise.all([first, second]);

    expect(order).toEqual(["first-start", "first-end", "second"]);
  });

  it("reports a pre-commit lock loss as not committed", async () => {
    const store = createFilesystemBlobStore({ rootDir });
    const key = createBranchLockKey("root-1", "branch-1");

    await expect(
      withBranchMutationLock(store, "root-1", "branch-1", async (lock) => {
        await store.put(key, JSON.stringify({ token: "other", createdAt: Date.now() }));
        await lock.beginCommit();
      }),
    ).rejects.toMatchObject({
      code: "branch_lock_lost_before_commit",
      outcome: "not_committed",
    } satisfies Partial<BranchMutationLockError>);
  });

  it("times out without committing when another lease remains current", async () => {
    const store = createFilesystemBlobStore({ rootDir });
    const key = createBranchLockKey("root-1", "branch-1");
    await store.put(key, JSON.stringify({ token: "other", createdAt: Date.now() }));

    await expect(
      withBranchMutationLock(store, "root-1", "branch-1", async () => "unreachable"),
    ).rejects.toMatchObject({
      code: "branch_lock_timeout",
      outcome: "not_committed",
    } satisfies Partial<BranchMutationLockError>);
  }, 30_000);

  it("returns a committed result with a structured cleanup warning", async () => {
    const delegate = createFilesystemBlobStore({ rootDir });
    const store: VoidBlobStore = {
      get: delegate.get,
      head: delegate.head,
      put: delegate.put,
      delete: async () => {
        throw new Error("delete response lost");
      },
      list: delegate.list,
    };
    const warning = jest.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await expect(
        withBranchMutationLock(store, "root-1", "branch-1", async (lock) => {
          await lock.beginCommit();
          return "committed";
        }),
      ).resolves.toBe("committed");
      expect(warning).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });

  it("reconciles a successful delete whose response is lost", async () => {
    const delegate = createFilesystemBlobStore({ rootDir });
    const store: VoidBlobStore = {
      get: delegate.get,
      head: delegate.head,
      put: delegate.put,
      delete: async (key) => {
        await delegate.delete(key);
        throw new Error("delete response lost");
      },
      list: delegate.list,
    };
    const warning = jest.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await expect(
        withBranchMutationLock(store, "root-1", "branch-1", async (lock) => {
          await lock.beginCommit();
          return "committed";
        }),
      ).resolves.toBe("committed");
      expect(warning).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });

  it("reports an unknown outcome when lock ownership is lost after commit begins", async () => {
    const store = createFilesystemBlobStore({ rootDir });
    const key = createBranchLockKey("root-1", "branch-1");
    const warning = jest.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await expect(
        withBranchMutationLock(store, "root-1", "branch-1", async (lock) => {
          await lock.beginCommit();
          await store.put(key, JSON.stringify({ token: "other", createdAt: Date.now() }));
          return "committed";
        }),
      ).rejects.toMatchObject({
        code: "branch_mutation_outcome_unknown",
        outcome: "unknown",
      } satisfies Partial<BranchMutationLockError>);
    } finally {
      warning.mockRestore();
    }
  });

  it("reports an unknown outcome when ownership cannot be read after commit begins", async () => {
    const delegate = createFilesystemBlobStore({ rootDir });
    let getCount = 0;
    const store: VoidBlobStore = {
      get: async (key) => {
        getCount += 1;
        if (getCount > 1) throw new Error("read unavailable");
        return delegate.get(key);
      },
      head: delegate.head,
      put: delegate.put,
      delete: delegate.delete,
      list: delegate.list,
    };
    const warning = jest.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await expect(
        withBranchMutationLock(store, "root-1", "branch-1", async (lock) => {
          await lock.beginCommit();
          return "committed";
        }),
      ).rejects.toMatchObject({
        code: "branch_mutation_outcome_unknown",
        outcome: "unknown",
      } satisfies Partial<BranchMutationLockError>);
    } finally {
      warning.mockRestore();
    }
  });

  it("preserves the original error before commit begins", async () => {
    const store = createFilesystemBlobStore({ rootDir });

    await expect(
      withBranchMutationLock(store, "root-1", "branch-1", async () => {
        throw new Error("validation failed");
      }),
    ).rejects.toThrow("validation failed");
  });

  it("reports an unknown outcome when work fails after commit begins", async () => {
    const store = createFilesystemBlobStore({ rootDir });

    await expect(
      withBranchMutationLock(store, "root-1", "branch-1", async (lock) => {
        await lock.beginCommit();
        throw new Error("write response lost");
      }),
    ).rejects.toMatchObject({
      code: "branch_mutation_outcome_unknown",
      outcome: "unknown",
    } satisfies Partial<BranchMutationLockError>);
  });
});

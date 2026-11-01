import { describe, expect, it, jest } from "@jest/globals";
import { MemoryBranchCommitStatePlane } from "../../../../../src/server/state-plane/memory-commits";
import { MemoryR2Bucket } from "../../diffs/testing/storage-fixture";
import { getBranchContent } from "./read";
import type { LocalBranchApplicationSelection } from "../../../../../src/server/state-plane/commit-application";

const rootDropId = "historyroot01";
const placement = { routingVersion: 1, generation: 1 };
const target = { rootDropId, branchId: "owner" };

const fixture = async (branchId = "owner") => {
  const commits = await MemoryBranchCommitStatePlane.create([
    {
      placement,
      content: "original",
      branch: {
        version: 1,
        ...target,
        branchId,
        baseDropId: rootDropId,
        mode: "owner",
        status: "active",
        ownerAccountId: "account",
        writerAccountId: "account",
        writerClientId: null,
        headSnapshotId: 0,
        headEventSeq: -1,
        createdAt: 1,
        updatedAt: 1,
      },
    },
  ]);
  const blobs = new MemoryR2Bucket();
  const env = {
    R2_BUCKET: blobs,
    localBranchApplication: {
      mode: "local-test",
      commits,
      placement,
    } as LocalBranchApplicationSelection,
  };
  const read = (query = "") =>
    getBranchContent(
      env,
      { rootId: rootDropId, branchId },
      new Request(
        `https://nulldown.test/api/branches/${rootDropId}/owner/content${query}`,
      ),
    );
  return { commits, env, read };
};

describe("branch content snapshot selection", () => {
  it("reads an unchanged clone identity derived from a maximum-length account", async () => {
    const branchId = `clone_account:${"a".repeat(120)}`;
    const { read } = await fixture(branchId);
    const response = await read();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      branchId,
      content: "original",
    });
  });

  it("returns snapshot zero and batch-terminal cursors for historical content", async () => {
    const { commits, env, read } = await fixture();
    env.localBranchApplication.history = commits;
    await commits.appendBatch({
      target,
      placement,
      events: [
        {
          dropId: rootDropId,
          eventId: "first",
          sourceClientId: "writer",
          seq: 0,
          createdAt: 2,
          ops: [{ type: "insert", start: 8, end: 8, text: " A" }],
        },
        {
          dropId: rootDropId,
          eventId: "second",
          sourceClientId: "writer",
          seq: 0,
          createdAt: 3,
          ops: [{ type: "insert", start: 10, end: 10, text: " B" }],
        },
      ],
    });
    const zero = await read("?snapshotId=0");
    expect(zero.status).toBe(200);
    expect(await zero.json()).toEqual({
      ...target,
      snapshotId: 0,
      headEventSeq: -1,
      content: "original",
    });
    const batch = await read("?snapshotId=1");
    expect(batch.status).toBe(200);
    expect(await batch.json()).toEqual({
      ...target,
      snapshotId: 1,
      headEventSeq: 1,
      content: "original A B",
    });
  });

  it("pins default content and cursor to the head captured before an intervening edit", async () => {
    const { commits, read } = await fixture();
    const originalRead = commits.readContent.bind(commits);
    jest.spyOn(commits, "readContent").mockImplementationOnce(async (query) => {
      await commits.appendBatch({
        target,
        placement,
        events: [
          {
            dropId: rootDropId,
            eventId: "later",
            sourceClientId: "writer",
            seq: 0,
            createdAt: 2,
            ops: [{ type: "insert", start: 8, end: 8, text: " later" }],
          },
        ],
      });
      return originalRead(query);
    });
    const response = await read();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ...target,
      snapshotId: 0,
      headEventSeq: -1,
      content: "original",
    });
    expect(
      (await commits.readHead({ target, placement })).version.snapshotId,
    ).toBe(1);
  });

  it.each(["", "-1", "1.5", "01", "NaN", "9007199254740992", "0&snapshotId=1"])(
    "rejects malformed or ambiguous snapshot selector %s",
    async (selector) => {
      const { commits, read } = await fixture();
      const content = jest.spyOn(commits, "readContent");
      expect((await read(`?snapshotId=${selector}`)).status).toBe(400);
      expect(content).not.toHaveBeenCalled();
    },
  );

  it("does not expose a snapshot beyond the captured head", async () => {
    const { commits, read } = await fixture();
    const content = jest.spyOn(commits, "readContent");
    expect((await read("?snapshotId=1")).status).toBe(404);
    expect(content).not.toHaveBeenCalled();
  });

  it("rejects history when the composition supplies commits only", async () => {
    const { commits, read } = await fixture();
    const content = jest.spyOn(commits, "readContent");
    const response = await read("?snapshotId=0");
    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({
      code: "capability_unsupported",
    });
    expect(content).not.toHaveBeenCalled();
  });
});

import type { DropEnvelope } from "../../../shared/drop/types";
import type { DropDiffEnvelope } from "../../../shared/drop/diff";
import { encodeDropEnvelope } from "../../../shared/drop/codecs/envelope-v1";
import { createHttpNulldownRuntime } from "./http-runtime";

const requestWithData =
  (data: unknown) =>
  async <T = unknown>() => ({ data: data as T });

describe("HTTP drop runtime", () => {
  it("posts a sealed create envelope without plaintext fields", async () => {
    const calls: Array<{ path: string; options?: RequestInit }> = [];
    const request = async <T = unknown>(
      path: string,
      options?: RequestInit,
    ) => {
      calls.push({ path, options });
      return {
        data: { id: "drop-1", url: "https://nulldown.test/d/drop-1" } as T,
      };
    };
    const runtime = createHttpNulldownRuntime({
      readDrop: async () => {
        throw new Error("unused");
      },
      request,
    });
    const envelope = {} as DropEnvelope;

    await runtime.drops.create({
      content: "plaintext",
      metadata: { themeId: "system" },
      envelope,
    });

    expect(calls).toEqual([
      {
        path: "/api/store",
        options: expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ envelope: encodeDropEnvelope(envelope) }),
        }),
      },
    ]);
  });

  it("preserves an update revision while replacing plaintext with an envelope", async () => {
    const calls: Array<{ path: string; options?: RequestInit }> = [];
    const request = async <T = unknown>(
      path: string,
      options?: RequestInit,
    ) => {
      calls.push({ path, options });
      return {
        data: { id: "drop-1", url: "https://nulldown.test/d/drop-1" } as T,
      };
    };
    const runtime = createHttpNulldownRuntime({
      readDrop: async () => {
        throw new Error("unused");
      },
      request,
    });
    const envelope = {} as DropEnvelope;

    await runtime.drops.update({
      id: "drop-1",
      content: "replacement",
      metadata: { themeId: "system" },
      envelope,
      expectedRevision: "revision-1",
    });

    expect(calls).toEqual([
      {
        path: "/api/store",
        options: expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            id: "drop-1",
            upsert: true,
            envelope: encodeDropEnvelope(envelope),
            expectedRevision: "revision-1",
          }),
        }),
      },
    ]);
  });

  it("accepts a complete diff receipt for every submitted event", async () => {
    const envelope: DropDiffEnvelope = {
      version: 1,
      events: [
        {
          eventId: "event-1",
          seq: 0,
          dropId: "drop-1",
          sourceClientId: "cli",
          createdAt: 1,
          ops: [],
        },
        {
          eventId: "event-2",
          seq: 1,
          dropId: "drop-1",
          sourceClientId: "cli",
          createdAt: 2,
          ops: [],
        },
      ],
    };
    const receipt = {
      accepted: 2,
      deduplicated: 0,
      branchId: "branch-1",
      snapshotId: 1,
      totalStored: 2,
      acknowledgements: [
        {
          eventId: "event-1",
          seq: 0,
          snapshotId: 1,
          status: "accepted" as const,
        },
        {
          eventId: "event-2",
          seq: 1,
          snapshotId: 1,
          status: "accepted" as const,
        },
      ],
    };
    const runtime = createHttpNulldownRuntime({
      readDrop: async () => {
        throw new Error("unused");
      },
      request: requestWithData(receipt),
    });

    await expect(
      runtime.diffs.postEnvelope({
        dropId: "drop-1",
        branchId: "branch-1",
        envelope,
      }),
    ).resolves.toEqual(receipt);
  });

  it("rejects a successful diff response without a durable receipt", async () => {
    const runtime = createHttpNulldownRuntime({
      readDrop: async () => {
        throw new Error("unused");
      },
      request: requestWithData({ accepted: 1 }),
    });
    const envelope: DropDiffEnvelope = {
      version: 1,
      events: [
        {
          eventId: "event-1",
          seq: 0,
          dropId: "drop-1",
          sourceClientId: "cli",
          createdAt: 1,
          ops: [],
        },
      ],
    };

    await expect(
      runtime.diffs.postEnvelope({ dropId: "drop-1", envelope }),
    ).rejects.toThrow("did not include a durable acknowledgement");
  });

  it("rejects a receipt that omits or duplicates a submitted event acknowledgement", async () => {
    const runtime = createHttpNulldownRuntime({
      readDrop: async () => {
        throw new Error("unused");
      },
      request: requestWithData({
        accepted: 2,
        deduplicated: 0,
        branchId: "branch-1",
        snapshotId: 1,
        totalStored: 2,
        acknowledgements: [
          {
            eventId: "event-1",
            seq: 0,
            snapshotId: 1,
            status: "accepted" as const,
          },
          {
            eventId: "event-1",
            seq: 1,
            snapshotId: 1,
            status: "accepted" as const,
          },
        ],
      }),
    });
    const envelope: DropDiffEnvelope = {
      version: 1,
      events: [
        {
          eventId: "event-1",
          seq: 0,
          dropId: "drop-1",
          sourceClientId: "cli",
          createdAt: 1,
          ops: [],
        },
        {
          eventId: "event-2",
          seq: 1,
          dropId: "drop-1",
          sourceClientId: "cli",
          createdAt: 2,
          ops: [],
        },
      ],
    };

    await expect(
      runtime.diffs.postEnvelope({ dropId: "drop-1", envelope }),
    ).rejects.toThrow("did not confirm every submitted event");
  });

  it("rejects a receipt for a different requested branch", async () => {
    const runtime = createHttpNulldownRuntime({
      readDrop: async () => {
        throw new Error("unused");
      },
      request: requestWithData({
        accepted: 1,
        deduplicated: 0,
        branchId: "other-branch",
        snapshotId: 1,
        totalStored: 1,
        acknowledgements: [
          {
            eventId: "event-1",
            seq: 0,
            snapshotId: 1,
            status: "accepted" as const,
          },
        ],
      }),
    });
    const envelope: DropDiffEnvelope = {
      version: 1,
      events: [
        {
          eventId: "event-1",
          seq: 0,
          dropId: "drop-1",
          sourceClientId: "cli",
          createdAt: 1,
          ops: [],
        },
      ],
    };

    await expect(
      runtime.diffs.postEnvelope({
        dropId: "drop-1",
        branchId: "branch-1",
        envelope,
      }),
    ).rejects.toThrow("did not confirm every submitted event");
  });
});

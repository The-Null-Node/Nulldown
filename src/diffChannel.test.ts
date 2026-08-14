import {
  createLocalDiffChannel,
  createRemoteDiffChannel,
  DiffChannelError,
} from "./lib/diff/diffChannel";

describe("remote diff channel", () => {
  it("reuses a supplied event id and returns the server acknowledgement", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return Response.json({
        accepted: 1,
        deduplicated: 0,
        branchId: "branch-1",
        snapshotId: 4,
        totalStored: 4,
        acknowledgements: [
          {
            eventId: "stable-event-1",
            seq: 3,
            snapshotId: 4,
            status: "accepted",
          },
        ],
      });
    };

    try {
      const channel = createRemoteDiffChannel({
        dropId: "root-1",
        branchId: "branch-1",
        clientId: "client-1",
      });
      const acknowledgements = await channel.publish(
        [{ type: "insert", start: 0, end: 0, text: "hello" }],
        { eventId: "stable-event-1", createdAt: 1_725_000_000_000 },
      );

      expect(acknowledgements).toEqual([
        {
          eventId: "stable-event-1",
          seq: 3,
          snapshotId: 4,
          status: "accepted",
        },
      ]);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe(
        "/api/diff/root-1?branchId=branch-1",
      );
      expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(
        expect.objectContaining({
          events: [
            expect.objectContaining({
              eventId: "stable-event-1",
              createdAt: 1_725_000_000_000,
            }),
          ],
        }),
      );
      channel.stop();
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("reuses an exact remote event after a failed request", async () => {
    const requestBodies: string[] = [];
    const previousFetch = globalThis.fetch;
    let attempts = 0;
    globalThis.fetch = async (_input, init) => {
      requestBodies.push(String(init?.body));
      attempts += 1;
      if (attempts === 1) throw new Error("network interrupted");
      return Response.json({
        accepted: 0,
        deduplicated: 1,
        branchId: "branch-1",
        snapshotId: 4,
        totalStored: 4,
        acknowledgements: [
          {
            eventId: "stable-event-1",
            seq: 3,
            snapshotId: 4,
            status: "duplicate",
          },
        ],
      });
    };

    try {
      const channel = createRemoteDiffChannel({
        dropId: "root-1",
        branchId: "branch-1",
        clientId: "client-1",
      });
      const options = { eventId: "stable-event-1", createdAt: 1_725_000_000_000 };
      const ops = [{ type: "insert" as const, start: 0, end: 0, text: "hello" }];

      await expect(channel.publish(ops, options)).rejects.toThrow("network interrupted");
      await expect(channel.publish(ops, options)).resolves.toEqual([
        {
          eventId: "stable-event-1",
          seq: 3,
          snapshotId: 4,
          status: "duplicate",
        },
      ]);
      expect(requestBodies).toHaveLength(2);
      expect(requestBodies[1]).toBe(requestBodies[0]);
      channel.stop();
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("refreshes account auth once without changing the event envelope", async () => {
    const requestBodies: string[] = [];
    const authorizationHeaders: string[] = [];
    const refreshOptions: Array<{ forceRefresh?: boolean } | undefined> = [];
    const previousFetch = globalThis.fetch;
    let attempts = 0;
    globalThis.fetch = async (_input, init) => {
      attempts += 1;
      requestBodies.push(String(init?.body));
      authorizationHeaders.push(
        String((init?.headers as Record<string, string>).Authorization),
      );
      if (attempts === 1) {
        return Response.json(
          { error: "Session expired.", code: "unauthorized" },
          { status: 401 },
        );
      }
      return Response.json({
        accepted: 1,
        deduplicated: 0,
        branchId: "branch-1",
        snapshotId: 4,
        totalStored: 4,
        acknowledgements: [
          {
            eventId: "stable-event-1",
            seq: 3,
            snapshotId: 4,
            status: "accepted",
          },
        ],
      });
    };

    try {
      const channel = createRemoteDiffChannel({
        dropId: "root-1",
        branchId: "branch-1",
        clientId: "client-1",
        authTokenProvider: async (options) => {
          refreshOptions.push(options);
          return options?.forceRefresh ? "refreshed-token" : "stale-token";
        },
      });

      await expect(
        channel.publish(
          [{ type: "insert", start: 0, end: 0, text: "hello" }],
          { eventId: "stable-event-1", createdAt: 1_725_000_000_000 },
        ),
      ).resolves.toHaveLength(1);
      expect(requestBodies).toEqual([requestBodies[0], requestBodies[0]]);
      expect(authorizationHeaders).toEqual([
        "Bearer stale-token",
        "Bearer refreshed-token",
      ]);
      expect(refreshOptions).toEqual([undefined, { forceRefresh: true }]);
      channel.stop();
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("retains structured transport failures for retry policy", async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      Response.json(
        { error: "Branch head changed.", code: "diff_predecessor_mismatch" },
        { status: 409 },
      );

    try {
      const channel = createRemoteDiffChannel({
        dropId: "root-1",
        branchId: "branch-1",
        clientId: "client-1",
      });
      await expect(
        channel.publish([{ type: "insert", start: 0, end: 0, text: "hello" }]),
      ).rejects.toMatchObject<Partial<DiffChannelError>>({
        name: "DiffChannelError",
        status: 409,
        code: "diff_predecessor_mismatch",
      });
      channel.stop();
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("deduplicates repeated local event identities", async () => {
    const channel = createLocalDiffChannel({
      dropId: "root-1",
      clientId: "client-1",
    });
    channel.start();
    const options = { eventId: "stable-event-1", createdAt: 1_725_000_000_000 };
    const ops = [{ type: "insert" as const, start: 0, end: 0, text: "hello" }];

    await expect(channel.publish(ops, options)).resolves.toEqual([
      { eventId: "stable-event-1", seq: 1, snapshotId: 1, status: "accepted" },
    ]);
    await expect(channel.publish(ops, options)).resolves.toEqual([
      { eventId: "stable-event-1", seq: 1, snapshotId: 1, status: "duplicate" },
    ]);
    channel.stop();
  });
});

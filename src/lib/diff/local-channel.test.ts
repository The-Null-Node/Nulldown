import { createLocalDiffChannel } from "./local-channel";

describe("local diff channel", () => {
  it("deduplicates repeated local event identities", async () => {
    const channel = createLocalDiffChannel({
      dropId: "root-1",
      clientId: "client-1",
    });
    channel.start();
    const options = {
      eventId: "stable-event-1",
      createdAt: 1_725_000_000_000,
    };
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

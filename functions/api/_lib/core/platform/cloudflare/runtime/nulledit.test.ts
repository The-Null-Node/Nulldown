import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { resolveBranchForActor } from "../../../../branches/lifecycle";
import {
  accountId,
  createSeededBucket,
  makeEvent,
  MemoryD1Database,
  rootDropId,
} from "../../../../diffs/testing/storage-fixture";
import { createCloudflareBackendRuntime } from "./composition";

describe("Cloudflare Nulledit runtime contracts", () => {
  it("runs server-runtime-registered snapshotters on future appends", async () => {
    const bucket = createSeededBucket();
    const db = new MemoryD1Database();
    const serverRuntime = createCloudflareBackendRuntime({
      R2_BUCKET: bucket as unknown as R2Bucket,
      DB: db as unknown as D1Database,
    }).serverRuntime;
    const { branch } = await resolveBranchForActor(
      bucket as unknown as R2Bucket,
      rootDropId,
      accountId,
      null,
    );
    const event = makeEvent({
      eventId: "evt-provider-registered",
      sourceClientId: "writer-provider-registered",
      text: "R",
      createdAt: 112,
    });
    const calls: string[] = [];
    const waitUntilPromises: Promise<void>[] = [];
    const unsubscribe = serverRuntime.nulledit.registerSnapshotter({
      id: "provider-registered-snapshotter",
      phase: "secondary",
      snapshot(context) {
        calls.push(
          `${context.snapshotId}:${context.acceptedEvents[0]?.eventId}`,
        );
      },
    });

    try {
      const appended = await serverRuntime.nulledit.appendDiffEvents({
        branch,
        events: [event],
        waitUntil: (promise) => {
          waitUntilPromises.push(promise);
        },
      });

      expect(appended.acceptedEvents).toHaveLength(1);
      expect(waitUntilPromises).toHaveLength(1);
      await waitUntilPromises[0];
      expect(calls).toEqual(["1:evt-provider-registered"]);
    } finally {
      unsubscribe();
    }
  });
});

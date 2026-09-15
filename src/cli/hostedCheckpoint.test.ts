import { Buffer } from "node:buffer";

import type {
  DropBranchContentResponse,
  DropBranchResolveResponse,
} from "../../shared/drop/branch";
import type {
  DropDiffAppendResponse,
  DropDiffEvent,
  DropDiffPollResponse,
} from "../../shared/drop/diff";
import { dropDiffOpToDiff } from "../../shared/drop/diff";
import { applyDiff } from "../../shared/nulledit/textDiff";
import type { NulldownDiffApplyRequest } from "../client/nulldownClient";
import {
  applyHostedCheckpointPlan,
  buildHostedCheckpointContent,
  createHostedCheckpointPlan,
  HostedCheckpointError,
  type HostedCheckpointApi,
  type HostedCheckpointInputV1,
  verifyHostedCheckpointPlan,
} from "./hostedCheckpoint";

const targetAccountId = "new-account";
const targetBranchId = `clone_account:${targetAccountId}`;
const keyFor = (rootId: string, branchId: string): string => `${rootId}:${branchId}`;

const content = (
  rootDropId: string,
  branchId: string,
  snapshotId: number,
  headEventSeq: number | null,
  text: string,
): DropBranchContentResponse => ({
  rootDropId,
  branchId,
  snapshotId,
  headEventSeq,
  content: text,
});

class CheckpointApi implements HostedCheckpointApi {
  readonly contents = new Map<string, DropBranchContentResponse>();
  readonly events = new Map<string, DropDiffEvent[]>();
  readonly applied: NulldownDiffApplyRequest[] = [];
  resolveCalls = 0;

  constructor() {
    this.contents.set(
      keyFor("master", "legacy-master"),
      content("master", "legacy-master", 102, 101, "# Legacy master\n\nCurrent plan.\n"),
    );
    this.contents.set(
      keyFor("master", targetBranchId),
      content("master", targetBranchId, 0, -1, "# Root master"),
    );
  }

  async getBranchContent(rootId: string, branchId: string): Promise<DropBranchContentResponse> {
    const result = this.contents.get(keyFor(rootId, branchId));
    if (!result) throw new Error(`Missing ${rootId}/${branchId}`);
    return { ...result };
  }

  async resolveBranch(rootId: string): Promise<DropBranchResolveResponse> {
    this.resolveCalls += 1;
    return {
      rootDropId: rootId,
      branchId: targetBranchId,
      mode: "clone",
      created: false,
      headSnapshotId: 0,
      ownerAccountId: null,
      writerAccountId: targetAccountId,
    };
  }

  async pollDiffEvents(
    rootId: string,
    branchId: string,
    cursor = -1,
  ): Promise<DropDiffPollResponse> {
    const events = this.events.get(keyFor(rootId, branchId)) ?? [];
    return {
      events: events.filter((event) => event.seq > cursor),
      cursor: String(Math.max(cursor, ...(events.map((event) => event.seq) ?? []))),
    };
  }

  async applyDiff(request: NulldownDiffApplyRequest): Promise<DropDiffAppendResponse> {
    this.applied.push(request);
    const branchId = request.branchId;
    if (!branchId) throw new Error("Missing test branch id.");
    const current = await this.getBranchContent(request.dropId, branchId);
    const nextContent = request.ops.reduce((value, op) => {
      const diff = dropDiffOpToDiff(op);
      if (!diff) throw new Error("Invalid test diff.");
      return applyDiff(value, diff);
    }, current.content);
    const nextSnapshot = current.snapshotId + 1;
    const eventId = request.eventId ?? "generated-event";
    const event: DropDiffEvent = {
      eventId,
      seq: (current.headEventSeq ?? -1) + 1,
      dropId: request.eventDropId ?? request.dropId,
      sourceClientId: "hosted-checkpoint",
      createdAt: request.createdAt ?? 1,
      snapshotId: nextSnapshot,
      ops: request.ops,
      metadata: request.metadata,
    };
    this.events.set(keyFor(request.dropId, branchId), [event]);
    this.contents.set(
      keyFor(request.dropId, branchId),
      content(request.dropId, branchId, nextSnapshot, (current.headEventSeq ?? -1) + 1, nextContent),
    );
    return {
      accepted: 1,
      deduplicated: 0,
      branchId,
      snapshotId: nextSnapshot,
      totalStored: 1,
      acknowledgements: [
        {
          eventId,
          seq: event.seq,
          snapshotId: nextSnapshot,
          status: "accepted",
        },
      ],
    };
  }
}

const input: HostedCheckpointInputV1 = {
  schema: "nulldown.hosted-checkpoint-input.v1",
  version: 1,
  checkpointId: "master-checkpoint-2026",
  targetAccountId,
  source: {
    rootId: "master",
    branchId: "legacy-master",
    expectedSnapshotId: 102,
  },
};

const tokenFor = (accountId: string, expiresAt = 20_000): string =>
  `ndacc.v1.${Buffer.from(
    JSON.stringify({ version: 1, accountId, iat: 1, exp: expiresAt }),
  ).toString("base64url")}.signature`;

describe("hosted checkpoint", () => {
  it("captures one legacy head and appends a traversable lineage footer", async () => {
    const api = new CheckpointApi();
    const plan = await createHostedCheckpointPlan(api, input, {
      now: () => 1_000,
      randomId: () => "stable-event",
    });
    const source = await api.getBranchContent("master", "legacy-master");
    const checkpoint = buildHostedCheckpointContent(plan, source.content);

    expect(plan.target).toEqual({
      branchId: targetBranchId,
      eventId: "hosted-checkpoint-stable-event",
      createdAt: 1_000,
    });
    expect(checkpoint.startsWith(source.content)).toBe(true);
    expect(checkpoint).toContain("legacy-master");
    expect(checkpoint).toContain("102");
    expect(checkpoint).toContain(targetBranchId);
    expect(api.resolveCalls).toBe(0);
  });

  it("posts one stable checkpoint diff and resumes without another mutation", async () => {
    const api = new CheckpointApi();
    const plan = await createHostedCheckpointPlan(api, input, {
      now: () => 1_000,
      randomId: () => "stable-event",
    });
    const completed = await applyHostedCheckpointPlan(api, plan, {
      token: tokenFor(targetAccountId),
      now: () => 2_000,
    });

    expect(api.applied).toHaveLength(1);
    expect(api.applied[0]).toEqual(
      expect.objectContaining({
        branchId: targetBranchId,
        eventId: "hosted-checkpoint-stable-event",
        createdAt: 1_000,
        metadata: expect.objectContaining({ followsSeq: -1 }),
      }),
    );
    expect(completed.verification).toEqual(
      expect.objectContaining({ resumed: false, targetSnapshotId: 1 }),
    );

    const resumed = await applyHostedCheckpointPlan(api, completed, {
      token: tokenFor(targetAccountId),
      now: () => 3_000,
    });
    expect(api.applied).toHaveLength(1);
    expect(resumed.verification).toEqual(expect.objectContaining({ resumed: true }));
    await expect(verifyHostedCheckpointPlan(api, resumed)).resolves.toBeUndefined();
  });

  it("rejects source-content drift before resolving or mutating the target", async () => {
    const api = new CheckpointApi();
    const plan = await createHostedCheckpointPlan(api, input, {
      randomId: () => "stable-event",
    });
    api.contents.set(
      keyFor("master", "legacy-master"),
      content("master", "legacy-master", 102, 101, "# Changed legacy master"),
    );

    await expect(
      applyHostedCheckpointPlan(api, plan, {
        token: tokenFor(targetAccountId),
        now: () => 2_000,
      }),
    ).rejects.toMatchObject<Partial<HostedCheckpointError>>({
      code: "source_changed",
    });
    expect(api.resolveCalls).toBe(0);
    expect(api.applied).toHaveLength(0);
  });

  it("rejects a non-fresh target clone instead of overwriting it", async () => {
    const api = new CheckpointApi();
    const plan = await createHostedCheckpointPlan(api, input, {
      randomId: () => "stable-event",
    });
    api.contents.set(
      keyFor("master", targetBranchId),
      content("master", targetBranchId, 1, 0, "# Concurrent target edit"),
    );

    await expect(
      applyHostedCheckpointPlan(api, plan, {
        token: tokenFor(targetAccountId),
        now: () => 2_000,
      }),
    ).rejects.toMatchObject<Partial<HostedCheckpointError>>({
      code: "target_conflict",
    });
    expect(api.applied).toHaveLength(0);
  });

  it("does not accept matching target text without the checkpoint event", async () => {
    const api = new CheckpointApi();
    const plan = await createHostedCheckpointPlan(api, input, {
      randomId: () => "stable-event",
    });
    const source = await api.getBranchContent("master", "legacy-master");
    api.contents.set(
      keyFor("master", targetBranchId),
      content(
        "master",
        targetBranchId,
        1,
        0,
        buildHostedCheckpointContent(plan, source.content),
      ),
    );

    await expect(
      applyHostedCheckpointPlan(api, plan, {
        token: tokenFor(targetAccountId),
        now: () => 2_000,
      }),
    ).rejects.toMatchObject<Partial<HostedCheckpointError>>({
      code: "target_conflict",
    });
    expect(api.applied).toHaveLength(0);
  });

  it("does not resume after a later edit restores the checkpoint text", async () => {
    const api = new CheckpointApi();
    const plan = await createHostedCheckpointPlan(api, input, {
      randomId: () => "stable-event",
    });
    const completed = await applyHostedCheckpointPlan(api, plan, {
      token: tokenFor(targetAccountId),
      now: () => 2_000,
    });
    const target = await api.getBranchContent("master", targetBranchId);
    api.contents.set(
      keyFor("master", targetBranchId),
      content("master", targetBranchId, 2, 1, target.content),
    );

    await expect(
      applyHostedCheckpointPlan(api, completed, {
        token: tokenFor(targetAccountId),
        now: () => 3_000,
      }),
    ).rejects.toMatchObject<Partial<HostedCheckpointError>>({
      code: "target_conflict",
    });
  });

  it("requires a current target-account bearer and rejects placeholders", async () => {
    const api = new CheckpointApi();
    await expect(
      createHostedCheckpointPlan(api, {
        ...input,
        targetAccountId: "replace-with-new-durable-account-id",
      }),
    ).rejects.toMatchObject<Partial<HostedCheckpointError>>({ code: "invalid_input" });
    await expect(
      applyHostedCheckpointPlan(
        api,
        await createHostedCheckpointPlan(api, input),
        { token: tokenFor(targetAccountId, 999), now: () => 1_000 },
      ),
    ).rejects.toMatchObject<Partial<HostedCheckpointError>>({
      code: "account_token_expired",
    });
  });
});

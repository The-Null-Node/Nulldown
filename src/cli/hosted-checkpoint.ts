import { createHash, randomUUID } from "node:crypto";

import type {
  DropBranchContentResponse,
  DropBranchResolveResponse,
} from "../../shared/drop/branch";
import type {
  DropDiffAppendResponse,
  DropDiffEvent,
  DropDiffEventMetadata,
  DropDiffPollResponse,
} from "../../shared/drop/diff";
import { diffToDropDiffOp } from "../../shared/drop/diff";
import { computeDiffOps } from "../../shared/nulledit/textDiff";
import type { NulldownDiffApplyRequest } from "../client/nulldown-client";

export const HOSTED_CHECKPOINT_INPUT_SCHEMA_V1 =
  "nulldown.hosted-checkpoint-input.v1" as const;
export const HOSTED_CHECKPOINT_PLAN_SCHEMA_V1 =
  "nulldown.hosted-checkpoint-plan.v1" as const;
export const HOSTED_CHECKPOINT_MARKER_PREFIX = "nulldown-hosted-checkpoint:v1";

const MAX_CHECKPOINT_CONTENT_LENGTH = 900_000;
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/u;

export interface HostedCheckpointSourceV1 {
  rootId: string;
  branchId: string;
  expectedSnapshotId: number;
}

/** Operator selection for exactly one legacy branch head. */
export interface HostedCheckpointInputV1 {
  schema: typeof HOSTED_CHECKPOINT_INPUT_SCHEMA_V1;
  version: 1;
  checkpointId: string;
  targetAccountId: string;
  source: HostedCheckpointSourceV1;
}

export interface HostedCheckpointSourceHeadV1 extends HostedCheckpointSourceV1 {
  headEventSeq: number | null;
  contentHash: string;
}

/** Durable local artifact used to apply or resume exactly one branch checkpoint. */
export interface HostedCheckpointPlanV1 {
  schema: typeof HOSTED_CHECKPOINT_PLAN_SCHEMA_V1;
  version: 1;
  checkpointId: string;
  targetAccountId: string;
  createdAt: number;
  source: HostedCheckpointSourceHeadV1;
  target: {
    branchId: string;
    eventId: string;
    createdAt: number;
  };
  verification?: {
    sourceSnapshotId: number;
    targetSnapshotId: number;
    verifiedAt: number;
    resumed: boolean;
  };
}

export interface HostedCheckpointApi {
  getBranchContent(
    rootId: string,
    branchId: string,
  ): Promise<DropBranchContentResponse>;
  resolveBranch(rootId: string): Promise<DropBranchResolveResponse>;
  pollDiffEvents(
    rootId: string,
    branchId: string,
    cursor?: number,
  ): Promise<DropDiffPollResponse>;
  applyDiff(
    request: NulldownDiffApplyRequest,
  ): Promise<DropDiffAppendResponse>;
}

export class HostedCheckpointError extends Error {
  constructor(
    readonly code:
      | "invalid_input"
      | "source_changed"
      | "target_conflict"
      | "target_invalid"
      | "account_token_invalid"
      | "account_token_expired"
      | "account_token_mismatch"
      | "content_too_large",
    message: string,
  ) {
    super(message);
    this.name = "HostedCheckpointError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isSafeId = (value: unknown): value is string =>
  typeof value === "string" && ID_PATTERN.test(value);

const assertInput = (input: HostedCheckpointInputV1): HostedCheckpointInputV1 => {
  if (
    input.schema !== HOSTED_CHECKPOINT_INPUT_SCHEMA_V1 ||
    input.version !== 1 ||
    !isSafeId(input.checkpointId) ||
    input.checkpointId.startsWith("replace-") ||
    !isSafeId(input.targetAccountId) ||
    input.targetAccountId.startsWith("replace-") ||
    !isSafeId(input.source.rootId) ||
    !isSafeId(input.source.branchId) ||
    !Number.isSafeInteger(input.source.expectedSnapshotId) ||
    input.source.expectedSnapshotId < 0
  ) {
    throw new HostedCheckpointError(
      "invalid_input",
      "Hosted checkpoint input is invalid.",
    );
  }
  return input;
};

const assertPlan = (plan: HostedCheckpointPlanV1): HostedCheckpointPlanV1 => {
  if (
    plan.schema !== HOSTED_CHECKPOINT_PLAN_SCHEMA_V1 ||
    plan.version !== 1 ||
    !isSafeId(plan.checkpointId) ||
    !isSafeId(plan.targetAccountId) ||
    !Number.isSafeInteger(plan.createdAt) ||
    !isSafeId(plan.source.rootId) ||
    !isSafeId(plan.source.branchId) ||
    !Number.isSafeInteger(plan.source.expectedSnapshotId) ||
    !isSafeId(plan.source.contentHash) ||
    (!Number.isSafeInteger(plan.source.headEventSeq) &&
      plan.source.headEventSeq !== null) ||
    !isSafeId(plan.target.branchId) ||
    !isSafeId(plan.target.eventId) ||
    !Number.isSafeInteger(plan.target.createdAt)
  ) {
    throw new HostedCheckpointError(
      "invalid_input",
      "Hosted checkpoint plan is invalid.",
    );
  }
  return plan;
};

/** Produces the stable source-head proof recorded in checkpoint lineage. */
export const hashHostedCheckpointContent = (content: string): string =>
  `sha256:${createHash("sha256").update(content, "utf8").digest("base64url")}`;

const parseBranchContent = (value: unknown): DropBranchContentResponse => {
  if (
    !isRecord(value) ||
    !isSafeId(value.rootDropId) ||
    !isSafeId(value.branchId) ||
    !Number.isSafeInteger(value.snapshotId) ||
    typeof value.content !== "string" ||
    (value.headEventSeq !== undefined &&
      value.headEventSeq !== null &&
      !Number.isSafeInteger(value.headEventSeq))
  ) {
    throw new HostedCheckpointError(
      "target_invalid",
      "Hosted branch content response is invalid.",
    );
  }
  return value as unknown as DropBranchContentResponse;
};

const parseResolvedBranch = (value: unknown): DropBranchResolveResponse => {
  if (
    !isRecord(value) ||
    !isSafeId(value.rootDropId) ||
    !isSafeId(value.branchId) ||
    typeof value.created !== "boolean" ||
    !Number.isSafeInteger(value.headSnapshotId) ||
    !isSafeId(value.writerAccountId)
  ) {
    throw new HostedCheckpointError(
      "target_invalid",
      "Hosted branch resolution response is invalid.",
    );
  }
  return value as unknown as DropBranchResolveResponse;
};

const parseDiffPoll = (value: unknown): DropDiffPollResponse => {
  if (
    !isRecord(value) ||
    !Array.isArray(value.events) ||
    !value.events.every(
      (event) =>
        isRecord(event) &&
        isSafeId(event.eventId) &&
        typeof event.seq === "number" &&
        Number.isSafeInteger(event.seq) &&
        event.seq >= 0 &&
        isSafeId(event.dropId) &&
        typeof event.sourceClientId === "string" &&
        typeof event.createdAt === "number" &&
        Number.isSafeInteger(event.createdAt) &&
        event.createdAt >= 0,
    )
  ) {
    throw new HostedCheckpointError(
      "target_invalid",
      "Hosted diff poll response is invalid.",
    );
  }
  return value as unknown as DropDiffPollResponse;
};

const readSourceHead = async (
  api: Pick<HostedCheckpointApi, "getBranchContent">,
  source: HostedCheckpointSourceV1,
): Promise<{ response: DropBranchContentResponse; head: HostedCheckpointSourceHeadV1 }> => {
  const response = parseBranchContent(
    await api.getBranchContent(source.rootId, source.branchId),
  );
  if (
    response.rootDropId !== source.rootId ||
    response.branchId !== source.branchId ||
    response.snapshotId !== source.expectedSnapshotId
  ) {
    throw new HostedCheckpointError(
      "source_changed",
      `Legacy head changed for ${source.rootId}/${source.branchId}.`,
    );
  }
  if (response.content.length > MAX_CHECKPOINT_CONTENT_LENGTH) {
    throw new HostedCheckpointError(
      "content_too_large",
      `Legacy head for ${source.rootId}/${source.branchId} exceeds the durable diff limit.`,
    );
  }
  return {
    response,
    head: {
      ...source,
      headEventSeq: response.headEventSeq ?? null,
      contentHash: hashHostedCheckpointContent(response.content),
    },
  };
};

/** Captures one legacy head without listing or replaying its snapshot history. */
export const createHostedCheckpointPlan = async (
  api: Pick<HostedCheckpointApi, "getBranchContent">,
  input: HostedCheckpointInputV1,
  options: { now?: () => number; randomId?: () => string } = {},
): Promise<HostedCheckpointPlanV1> => {
  const valid = assertInput(input);
  const now = options.now ?? Date.now;
  const randomId = options.randomId ?? randomUUID;
  const captured = await readSourceHead(api, valid.source);
  return {
    schema: HOSTED_CHECKPOINT_PLAN_SCHEMA_V1,
    version: 1,
    checkpointId: valid.checkpointId,
    targetAccountId: valid.targetAccountId,
    createdAt: now(),
    source: captured.head,
    target: {
      branchId: `clone_account:${valid.targetAccountId}`,
      eventId: `hosted-checkpoint-${randomId()}`,
      createdAt: now(),
    },
  };
};

const checkpointMarker = (plan: HostedCheckpointPlanV1): string =>
  `<!-- ${HOSTED_CHECKPOINT_MARKER_PREFIX}:${plan.checkpointId} -->`;

/** Preserves the legacy head as an exact prefix and appends its backward traversal coordinates. */
export const buildHostedCheckpointContent = (
  plan: HostedCheckpointPlanV1,
  sourceContent: string,
): string => {
  const separator = sourceContent.endsWith("\n") ? "\n---\n\n" : "\n\n---\n\n";
  const content = [
    sourceContent,
    separator,
    checkpointMarker(plan),
    "## Legacy Checkpoint Lineage",
    "",
    `- Checkpoint: \`${plan.checkpointId}\``,
    `- Legacy root: \`${plan.source.rootId}\``,
    `- Legacy branch: \`${plan.source.branchId}\``,
    `- Legacy snapshot: \`${plan.source.expectedSnapshotId}\``,
    `- Legacy event sequence: \`${plan.source.headEventSeq ?? "-"}\``,
    `- Legacy content hash: \`${plan.source.contentHash}\``,
    `- Writable continuation: \`${plan.target.branchId}\``,
    "",
    "Use the recorded root, branch, and snapshot to traverse legacy history on demand. This checkpoint does not copy child branches, memory records, or earlier snapshots.",
    "",
  ].join("\n");
  if (content.length > MAX_CHECKPOINT_CONTENT_LENGTH) {
    throw new HostedCheckpointError(
      "content_too_large",
      `Checkpoint ${plan.checkpointId} exceeds the durable diff limit.`,
    );
  }
  return content;
};

const assertTargetToken = (
  token: string | null | undefined,
  targetAccountId: string,
  now: number,
): void => {
  if (!token) {
    throw new HostedCheckpointError(
      "account_token_invalid",
      "Hosted checkpoint requires a target account bearer token.",
    );
  }
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "ndacc" || parts[1] !== "v1") {
    throw new HostedCheckpointError(
      "account_token_invalid",
      "Hosted checkpoint requires an ndacc.v1 account token.",
    );
  }
  try {
    const claims = JSON.parse(
      Buffer.from(parts[2], "base64url").toString("utf8"),
    ) as unknown;
    const accountId = isRecord(claims) ? claims.accountId : null;
    const expiresAt = isRecord(claims) ? claims.exp : null;
    if (!isSafeId(accountId) || typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt)) {
      throw new Error("invalid claims");
    }
    if (expiresAt <= now) {
      throw new HostedCheckpointError(
        "account_token_expired",
        "Hosted checkpoint account token is expired.",
      );
    }
    if (accountId !== targetAccountId) {
      throw new HostedCheckpointError(
        "account_token_mismatch",
        "Hosted checkpoint token does not own the planned target account.",
      );
    }
  } catch (error) {
    if (error instanceof HostedCheckpointError) throw error;
    throw new HostedCheckpointError(
      "account_token_invalid",
      "Hosted checkpoint account token claims are invalid.",
    );
  }
};

const assertCapturedSource = async (
  api: Pick<HostedCheckpointApi, "getBranchContent">,
  plan: HostedCheckpointPlanV1,
): Promise<DropBranchContentResponse> => {
  const captured = await readSourceHead(api, plan.source);
  if (
    captured.head.headEventSeq !== plan.source.headEventSeq ||
    captured.head.contentHash !== plan.source.contentHash
  ) {
    throw new HostedCheckpointError(
      "source_changed",
      `Captured legacy head changed for ${plan.source.rootId}/${plan.source.branchId}.`,
    );
  }
  return captured.response;
};

const checkpointMetadata = (plan: HostedCheckpointPlanV1): DropDiffEventMetadata => ({
  kind: "agent.edit",
  intent: "Create a one-layer writable checkpoint from a legacy branch head.",
  labels: ["hosted-checkpoint", "lineage"],
  confidence: 1,
  args: {
    summary: `Checkpoints ${plan.source.rootId}/${plan.source.branchId} at snapshot ${plan.source.expectedSnapshotId}.`,
    checkpointId: plan.checkpointId,
    sourceRootId: plan.source.rootId,
    sourceBranchId: plan.source.branchId,
    sourceSnapshotId: plan.source.expectedSnapshotId,
    sourceHeadEventSeq: plan.source.headEventSeq,
    sourceContentHash: plan.source.contentHash,
  },
});

const readCheckpointEvent = async (
  api: Pick<HostedCheckpointApi, "pollDiffEvents">,
  plan: HostedCheckpointPlanV1,
  expectedHead?: { snapshotId: number; eventSeq: number },
): Promise<(DropDiffEvent & { snapshotId: number }) | null> => {
  const response = parseDiffPoll(
    await api.pollDiffEvents(plan.source.rootId, plan.target.branchId, -1),
  );
  const event = response.events.find(
    (candidate) => candidate.eventId === plan.target.eventId,
  );
  if (!event) return null;

  const args = event.metadata?.args;
  if (
    event.dropId !== plan.source.rootId ||
    event.seq !== 0 ||
    event.sourceClientId !== "hosted-checkpoint" ||
    event.createdAt !== plan.target.createdAt ||
    !Number.isSafeInteger(event.snapshotId) ||
    event.metadata?.kind !== "agent.edit" ||
    !isRecord(args) ||
    args.checkpointId !== plan.checkpointId ||
    args.sourceRootId !== plan.source.rootId ||
    args.sourceBranchId !== plan.source.branchId ||
    args.sourceSnapshotId !== plan.source.expectedSnapshotId ||
    args.sourceHeadEventSeq !== plan.source.headEventSeq ||
    args.sourceContentHash !== plan.source.contentHash ||
    (expectedHead !== undefined &&
      (event.snapshotId !== expectedHead.snapshotId ||
        event.seq !== expectedHead.eventSeq))
  ) {
    throw new HostedCheckpointError(
      "target_conflict",
      `Checkpoint event identity is inconsistent for ${plan.checkpointId}.`,
    );
  }
  return event as DropDiffEvent & { snapshotId: number };
};

/** Applies or resumes the one allowed checkpoint diff after exact source and target checks. */
export const applyHostedCheckpointPlan = async (
  api: HostedCheckpointApi,
  planValue: HostedCheckpointPlanV1,
  options: { token: string | null | undefined; now?: () => number } = { token: null },
): Promise<HostedCheckpointPlanV1> => {
  const plan = assertPlan(planValue);
  const now = options.now ?? Date.now;
  assertTargetToken(options.token, plan.targetAccountId, now());
  const source = await assertCapturedSource(api, plan);
  const resolved = parseResolvedBranch(await api.resolveBranch(plan.source.rootId));
  if (
    resolved.rootDropId !== plan.source.rootId ||
    resolved.branchId !== plan.target.branchId ||
    resolved.writerAccountId !== plan.targetAccountId
  ) {
    throw new HostedCheckpointError(
      "target_invalid",
      `Resolved branch does not belong to ${plan.targetAccountId}.`,
    );
  }

  const desired = buildHostedCheckpointContent(plan, source.content);
  const current = parseBranchContent(
    await api.getBranchContent(plan.source.rootId, resolved.branchId),
  );
  const existingEvent = await readCheckpointEvent(api, plan, {
    snapshotId: current.snapshotId,
    eventSeq: current.headEventSeq ?? -1,
  });
  let resumed = false;
  let targetSnapshotId = current.snapshotId;
  if (
    current.content === desired &&
    existingEvent &&
    existingEvent.snapshotId === current.snapshotId
  ) {
    resumed = true;
    targetSnapshotId = existingEvent.snapshotId;
  } else {
    if (current.snapshotId !== 0 || (current.headEventSeq ?? null) !== -1) {
      throw new HostedCheckpointError(
        "target_conflict",
        `Target branch ${resolved.branchId} already contains unrelated edits.`,
      );
    }
    const receipt = await api.applyDiff({
      dropId: plan.source.rootId,
      branchId: resolved.branchId,
      eventDropId: plan.source.rootId,
      eventId: plan.target.eventId,
      createdAt: plan.target.createdAt,
      ops: computeDiffOps(current.content, desired).map(diffToDropDiffOp),
      metadata: {
        ...checkpointMetadata(plan),
        followsSeq: current.headEventSeq ?? -1,
      },
    });
    const acknowledgement = receipt.acknowledgements.find(
      (candidate) => candidate.eventId === plan.target.eventId,
    );
    if (
      receipt.branchId !== resolved.branchId ||
      !acknowledgement ||
      (acknowledgement.status !== "accepted" &&
        acknowledgement.status !== "duplicate")
    ) {
      throw new HostedCheckpointError(
        "target_invalid",
        `Checkpoint event was not durably acknowledged for ${plan.checkpointId}.`,
      );
    }
    const verified = parseBranchContent(
      await api.getBranchContent(plan.source.rootId, resolved.branchId),
    );
    if (verified.content !== desired) {
      throw new HostedCheckpointError(
        "target_conflict",
        `Checkpoint verification failed for ${plan.checkpointId}.`,
      );
    }
    const checkpointEvent = await readCheckpointEvent(api, plan, {
      snapshotId: verified.snapshotId,
      eventSeq: verified.headEventSeq ?? -1,
    });
    if (!checkpointEvent) {
      throw new HostedCheckpointError(
        "target_invalid",
        `Checkpoint event could not be read back for ${plan.checkpointId}.`,
      );
    }
    targetSnapshotId = checkpointEvent.snapshotId;
  }
  return {
    ...plan,
    verification: {
      sourceSnapshotId: plan.source.expectedSnapshotId,
      targetSnapshotId,
      verifiedAt: now(),
      resumed,
    },
  };
};

/** Verifies the recorded legacy head and checkpoint bytes without posting a diff. */
export const verifyHostedCheckpointPlan = async (
  api: Pick<HostedCheckpointApi, "getBranchContent" | "pollDiffEvents">,
  planValue: HostedCheckpointPlanV1,
): Promise<void> => {
  const plan = assertPlan(planValue);
  const source = await assertCapturedSource(api, plan);
  const target = parseBranchContent(
    await api.getBranchContent(plan.source.rootId, plan.target.branchId),
  );
  const checkpointEvent = await readCheckpointEvent(api, plan, {
    snapshotId: target.snapshotId,
    eventSeq: target.headEventSeq ?? -1,
  });
  if (!checkpointEvent) {
    throw new HostedCheckpointError(
      "target_conflict",
      `Checkpoint event is missing for ${plan.checkpointId}.`,
    );
  }
  if (target.content !== buildHostedCheckpointContent(plan, source.content)) {
    throw new HostedCheckpointError(
      "target_conflict",
      `Checkpoint verification failed for ${plan.checkpointId}.`,
    );
  }
};

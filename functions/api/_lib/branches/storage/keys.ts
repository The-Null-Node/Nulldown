/** R2 prefix for branch records. */
export const BRANCH_KEY_PREFIX = "__drop_branch__/";
/** R2 prefix for branch snapshot records. */
export const SNAPSHOT_KEY_PREFIX = "__drop_snapshot__/";
/** Stable branch id for the root owner's canonical branch. */
export const OWNER_BRANCH_ID = "owner";
/** Number of snapshots between branch content checkpoints. */
export const DEFAULT_CHECKPOINT_INTERVAL = 24;

/** R2 prefix for writer-to-branch pointer records. */
export const WRITER_BRANCH_KEY_PREFIX = "__drop_writer_branch__/";
const CHECKPOINT_KEY_PREFIX = "__drop_checkpoint__/";
const BRANCH_DIFF_LOG_KEY_PREFIX = "__drop_branch_diffs__/";
/** R2 prefix for per-sequence branch diff event records. */
export const BRANCH_DIFF_EVENT_KEY_PREFIX = "__drop_branch_diff_events__/";
const BRANCH_DIFF_EVENT_ID_KEY_PREFIX = "__drop_branch_diff_event_ids__/";
const BRANCH_LOCK_KEY_PREFIX = "__drop_branch_lock__/";
const EVENT_SEQ_PAD = 16;

/** Sanitizes a dynamic branch key segment before embedding it in an R2 key. */
export const sanitizeBranchKeyPart = (value: string): string =>
  value.replace(/[^A-Za-z0-9._:-]/g, "_");

/** Builds the R2 key for a persisted branch record. */
export const createBranchKey = (rootDropId: string, branchId: string): string =>
  `${BRANCH_KEY_PREFIX}${rootDropId}/${branchId}.json`;

/** Builds the R2 key for the writer-to-branch pointer. */
export const createWriterBranchKey = (
  rootDropId: string,
  writerKey: string,
): string => `${WRITER_BRANCH_KEY_PREFIX}${rootDropId}/${writerKey}.txt`;

/** Builds the R2 key for a branch snapshot record. */
export const createSnapshotKey = (
  rootDropId: string,
  branchId: string,
  snapshotId: number,
): string =>
  `${SNAPSHOT_KEY_PREFIX}${rootDropId}/${branchId}/${snapshotId}.json`;

/** Builds the R2 key for a branch snapshot checkpoint body. */
export const createCheckpointKey = (
  rootDropId: string,
  branchId: string,
  snapshotId: number,
): string =>
  `${CHECKPOINT_KEY_PREFIX}${rootDropId}/${branchId}/${snapshotId}.txt`;

/** Builds the legacy R2 key for a full branch diff log. */
export const createBranchDiffLogKey = (
  rootDropId: string,
  branchId: string,
): string => `${BRANCH_DIFF_LOG_KEY_PREFIX}${rootDropId}/${branchId}.json`;

/** Builds the R2 prefix for per-event branch diff objects. */
export const createBranchDiffEventPrefix = (
  rootDropId: string,
  branchId: string,
): string => `${BRANCH_DIFF_EVENT_KEY_PREFIX}${rootDropId}/${branchId}/`;

/** Builds the R2 key for a per-sequence branch diff event object. */
export const createBranchDiffEventKey = (
  rootDropId: string,
  branchId: string,
  seq: number,
): string =>
  `${createBranchDiffEventPrefix(rootDropId, branchId)}${String(seq).padStart(EVENT_SEQ_PAD, "0")}.json`;

/** Builds the R2 key used to dedupe a branch diff event id. */
export const createBranchDiffEventIdKey = (
  rootDropId: string,
  branchId: string,
  eventId: string,
): string =>
  `${BRANCH_DIFF_EVENT_ID_KEY_PREFIX}${rootDropId}/${branchId}/${sanitizeBranchKeyPart(eventId)}.txt`;

/** Builds the R2 key for the coarse branch mutation lock. */
export const createBranchLockKey = (
  rootDropId: string,
  branchId: string,
): string => `${BRANCH_LOCK_KEY_PREFIX}${rootDropId}/${branchId}.json`;

/** Builds the stable writer identity key used to assign clone branches. */
export const createWriterKey = (
  accountId: string | null,
  clientId: string | null,
): string => {
  if (accountId) {
    return `account:${sanitizeBranchKeyPart(accountId)}`;
  }

  if (clientId) {
    return `client:${sanitizeBranchKeyPart(clientId)}`;
  }

  return "anonymous";
};

/** Builds the clone branch id for a stable writer key. */
export const createCloneBranchId = (writerKey: string): string =>
  `clone_${sanitizeBranchKeyPart(writerKey)}`;

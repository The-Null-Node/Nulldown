/** Maximum stable account-clone identity: the `clone_account:` prefix plus a 120-character account ID. */
export const MAX_BRANCH_ID_LENGTH = 134;

/** Validates a branch route identifier without applying the shorter credential/client token limit. */
export const sanitizeBranchId = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return id.length <= MAX_BRANCH_ID_LENGTH && /^[A-Za-z0-9._:-]+$/.test(id)
    ? id
    : null;
};

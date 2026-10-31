import type { BranchStateError } from "../../../../../shared/drop/branch-state";
import { jsonErrorResponse } from "../../core/http/responses";

/** Translates a content-free authority failure at the request boundary without retrying another store. */
export const branchStateErrorResponse = (error: BranchStateError): Response => {
  const { code, status, outcome, retry } = error.toRecord();
  return jsonErrorResponse(
    status,
    code,
    retry === "same-command"
      ? "Branch commit outcome could not be confirmed. Retry the exact same events."
      : retry === "refresh"
        ? "Branch state changed. Refresh before retrying."
        : "The selected branch authority could not complete this operation.",
    { outcome, retry },
  );
};

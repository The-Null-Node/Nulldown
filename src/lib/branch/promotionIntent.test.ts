/** @jest-environment jsdom */

import {
  clearBranchPromotionIntent,
  readBranchPromotionIntent,
  writeBranchPromotionIntent,
} from "./promotionIntent";

const intent = {
  rootDropId: "root-1",
  branchId: "branch-1",
  snapshotId: 4,
  idempotencyKey: "promotion-key",
};

describe("branch promotion intent", () => {
  beforeEach(() => window.localStorage.clear());

  it("retains the exact fenced request pair across a reload", () => {
    writeBranchPromotionIntent(intent);

    expect(readBranchPromotionIntent(intent.rootDropId, intent.branchId)).toEqual(intent);
    clearBranchPromotionIntent(intent.rootDropId, intent.branchId);
    expect(readBranchPromotionIntent(intent.rootDropId, intent.branchId)).toBeNull();
  });
});

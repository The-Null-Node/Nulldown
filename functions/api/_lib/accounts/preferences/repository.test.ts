import { describe, expect, it } from "@jest/globals";

import { advanceAccountPreferenceField } from "./repository";
import { createAccountPreferenceDatabase } from "./testing/repository-fixture";

describe("account preferences repository", () => {
  it("uses a field-local revision precondition and acknowledges only its own update", async () => {
    const db = createAccountPreferenceDatabase({
      preference_key: "syntaxMode",
      preference_value: "source",
      revision: 4,
      updated_at: 20,
    });

    await expect(
      advanceAccountPreferenceField(db as never, {
        userId: "user-a",
        field: "syntaxMode",
        value: "source",
        expectedRevision: 3,
        updatedAt: 20,
      }),
    ).resolves.toEqual({
      applied: true,
      current: {
        preference_key: "syntaxMode",
        preference_value: "source",
        revision: 4,
        updated_at: 20,
      },
    });
    expect(db.prepare.mock.calls[0][0]).toContain(
      "preference_key = ? AND revision = ?",
    );
    expect(db.writeStatement.bind).toHaveBeenCalledWith(
      "source",
      20,
      "user-a",
      "syntaxMode",
      3,
    );
  });

  it("reports a stale field revision as a conflict without treating another write as its own", async () => {
    const db = createAccountPreferenceDatabase({
      preference_key: "syntaxMode",
      preference_value: "rendered",
      revision: 4,
      updated_at: 19,
    });

    await expect(
      advanceAccountPreferenceField(db as never, {
        userId: "user-a",
        field: "syntaxMode",
        value: "source",
        expectedRevision: 3,
        updatedAt: 20,
      }),
    ).resolves.toMatchObject({
      applied: false,
      current: {
        preference_value: "rendered",
        revision: 4,
        updated_at: 19,
      },
    });
  });
});

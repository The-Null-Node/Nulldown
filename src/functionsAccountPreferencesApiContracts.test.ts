import { describe, expect, it, jest } from "@jest/globals";
import { advanceAccountPreferenceField } from "../functions/api/_lib/accounts/preferences/repository";

const createDatabase = (row: {
  preference_key: "syntaxMode";
  preference_value: string;
  revision: number;
  updated_at: number;
}) => {
  const writeStatement = {
    bind: jest.fn(),
    run: jest.fn().mockResolvedValue(undefined),
  };
  writeStatement.bind.mockReturnValue(writeStatement);
  const readStatement = {
    bind: jest.fn(),
    first: jest.fn().mockResolvedValue(row),
  };
  readStatement.bind.mockReturnValue(readStatement);
  const prepare = jest
    .fn()
    .mockReturnValueOnce(writeStatement)
    .mockReturnValueOnce(readStatement);
  return { prepare, writeStatement, readStatement };
};

describe("account preferences repository", () => {
  it("uses a field-local revision precondition and acknowledges only its own update", async () => {
    const db = createDatabase({
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
    expect(db.prepare.mock.calls[0][0]).toContain("preference_key = ? AND revision = ?");
    expect(db.writeStatement.bind).toHaveBeenCalledWith("source", 20, "user-a", "syntaxMode", 3);
  });

  it("reports a stale field revision as a conflict without treating another write as its own", async () => {
    const db = createDatabase({
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
      current: { preference_value: "rendered", revision: 4, updated_at: 19 },
    });
  });
});

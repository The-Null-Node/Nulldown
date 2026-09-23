import { beforeEach, describe, expect, it, jest } from "@jest/globals";

import {
  createAccountPreferenceMutation,
  createDefaultAccountPreferences,
  decodeAccountPreferences,
  encodeAccountPreferenceMutation,
} from "../../../../../shared/auth/codecs/account-preferences-v1";
import { createAccountPreferenceDatabase } from "./testing/repository-fixture";

const isSameOriginOpenAuthRequest = jest.fn();
const resolveOpenAuthRequestIdentity = jest.fn();

jest.unstable_mockModule("../open-auth/service", () => ({
  isSameOriginOpenAuthRequest,
  resolveOpenAuthRequestIdentity,
}));

const { readAccountPreferencesResponse, updateAccountPreferenceResponse } =
  await import("./service");

describe("account preferences service", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    isSameOriginOpenAuthRequest.mockReturnValue(true);
  });

  it("encodes the authenticated user's canonical snapshot as V1 at the HTTP response boundary", async () => {
    const all = jest.fn().mockResolvedValue({
      results: [
        {
          preference_key: "syntaxMode",
          preference_value: "source",
          revision: 3,
          updated_at: 9,
        },
      ],
    });
    const statement = { bind: jest.fn(), all };
    statement.bind.mockReturnValue(statement);
    const db = { prepare: jest.fn().mockReturnValue(statement) };
    resolveOpenAuthRequestIdentity.mockResolvedValue({
      db,
      userId: "user-a",
      responseHeaders: new Headers(),
    });

    const response = await readAccountPreferencesResponse(
      {} as never,
      new Request("https://app.test/api/account/preferences"),
    );
    const snapshot = createDefaultAccountPreferences();
    snapshot.fields.syntaxMode = {
      value: "source",
      revision: 3,
      updatedAt: 9,
    };
    const body = await response.json();

    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body).toMatchObject({
      schema: "nulldown.account-preferences.v1",
      version: 1,
    });
    expect(decodeAccountPreferences(body)).toEqual(snapshot);
    expect(statement.bind).toHaveBeenCalledWith("user-a");
  });

  it("decodes a V1 mutation before applying its field-local revision precondition", async () => {
    const db = createAccountPreferenceDatabase({
      preference_key: "syntaxMode",
      preference_value: "source",
      revision: 4,
      updated_at: 20,
    });
    resolveOpenAuthRequestIdentity.mockResolvedValue({
      db,
      userId: "user-a",
      origin: "https://app.test",
      responseHeaders: new Headers(),
    });
    jest.spyOn(Date, "now").mockReturnValue(20);
    const mutation = createAccountPreferenceMutation("syntaxMode", "source", 3);

    const response = await updateAccountPreferenceResponse(
      {} as never,
      new Request("https://app.test/api/account/preferences", {
        method: "PATCH",
        body: JSON.stringify(encodeAccountPreferenceMutation(mutation)),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      field: "syntaxMode",
      current: { value: "source", revision: 4, updatedAt: 20 },
    });
    expect(db.writeStatement.bind).toHaveBeenCalledWith(
      "source",
      expect.any(Number),
      "user-a",
      "syntaxMode",
      3,
    );
  });
});

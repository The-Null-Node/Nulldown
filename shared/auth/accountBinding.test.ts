import {
  ACCOUNT_BINDING_CHALLENGE_SCHEMA_V1,
  ACCOUNT_BINDING_OPERATION_V1,
  parseAccountBindingChallenge,
  serializeAccountBindingChallenge,
  type AccountBindingChallengeV1,
} from "./accountBinding";

const challenge: AccountBindingChallengeV1 = {
  schema: ACCOUNT_BINDING_CHALLENGE_SCHEMA_V1,
  version: 1,
  operation: ACCOUNT_BINDING_OPERATION_V1,
  challengeId: "a".repeat(43),
  nonce: "b".repeat(43),
  userId: "user_01",
  accountId: "account-01",
  origin: "https://nulldown.app",
  signingKeyFingerprint: `sha256:${"c".repeat(43)}`,
  issuedAt: 1_000,
  expiresAt: 61_000,
};

describe("account-binding challenge contract", () => {
  it("serializes every authority field in a stable domain-separated order", () => {
    expect(serializeAccountBindingChallenge(challenge)).toBe(
      [
        "nulldown.account-binding-challenge.v1",
        "1",
        "bind-account",
        "a".repeat(43),
        "b".repeat(43),
        "user_01",
        "account-01",
        "https://nulldown.app",
        `sha256:${"c".repeat(43)}`,
        "1000",
        "61000",
      ].join("\n"),
    );
  });

  it("rejects missing, extra, malformed, and non-HTTPS authority fields", () => {
    expect(parseAccountBindingChallenge(challenge)).toEqual(challenge);
    expect(parseAccountBindingChallenge({ ...challenge, userId: "other\nuser" })).toBeNull();
    expect(parseAccountBindingChallenge({ ...challenge, origin: "http://nulldown.app" })).toBeNull();
    expect(parseAccountBindingChallenge({ ...challenge, expiresAt: challenge.issuedAt })).toBeNull();
    expect(parseAccountBindingChallenge({ ...challenge, extra: true })).toBeNull();
  });
});

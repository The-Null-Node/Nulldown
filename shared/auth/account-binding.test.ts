import {
  type AccountBindingChallenge,
} from "./account-binding";
import {
  ACCOUNT_BINDING_CHALLENGE_SCHEMA_V1,
  ACCOUNT_BINDING_OPERATION_V1,
  decodeAccountBindingChallenge,
  encodeAccountBindingChallenge,
  serializeAccountBindingChallenge,
} from "./codecs/account-binding-v1";

const challenge: AccountBindingChallenge = {
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

  it("decodes and round-trips the legacy challenge without retaining wire fields", () => {
    const raw = JSON.stringify({
      schema: ACCOUNT_BINDING_CHALLENGE_SCHEMA_V1,
      version: 1,
      operation: ACCOUNT_BINDING_OPERATION_V1,
      ...challenge,
    });
    const decoded = decodeAccountBindingChallenge(JSON.parse(raw));

    expect(decoded).toEqual(challenge);
    expect(decoded).not.toHaveProperty("schema");
    expect(JSON.stringify(encodeAccountBindingChallenge(decoded!))).toBe(raw);
  });

  it("rejects missing, extra, malformed, and non-HTTPS authority fields", () => {
    expect(
      decodeAccountBindingChallenge({
        ...encodeAccountBindingChallenge(challenge),
        userId: "other\nuser",
      }),
    ).toBeNull();
    expect(
      decodeAccountBindingChallenge({
        ...encodeAccountBindingChallenge(challenge),
        origin: "http://nulldown.app",
      }),
    ).toBeNull();
    expect(
      decodeAccountBindingChallenge({
        ...encodeAccountBindingChallenge(challenge),
        expiresAt: challenge.issuedAt,
      }),
    ).toBeNull();
    expect(
      decodeAccountBindingChallenge({
        ...encodeAccountBindingChallenge(challenge),
        extra: true,
      }),
    ).toBeNull();
  });
});

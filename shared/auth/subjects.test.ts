import {
  NULDOWN_USER_SUBJECT_TYPE,
  createNulldownUserPrincipal,
  createNulldownUserSubject,
  parseNulldownIdentity,
  parseNulldownUserPrincipal,
  parseNulldownUserSubject,
} from "./subjects";

describe("Nulldown recoverable-user subjects", () => {
  it("parses only the exact v1 user subject", () => {
    expect(parseNulldownUserSubject({ version: 1, userId: "user_01" })).toEqual({
      version: 1,
      userId: "user_01",
    });
    expect(parseNulldownUserSubject({ version: 2, userId: "user_01" })).toBeNull();
    expect(parseNulldownUserSubject({ version: 1, userId: " user_01 " })).toBeNull();
    expect(
      parseNulldownUserSubject({ version: 1, userId: "user_01", email: "a@b.test" }),
    ).toBeNull();
  });

  it("normalizes a verified principal to its stable v1 shape", () => {
    const principal = createNulldownUserPrincipal("user_01");

    expect(principal).toEqual({
      type: NULDOWN_USER_SUBJECT_TYPE,
      properties: { version: 1, userId: "user_01" },
    });
    expect(parseNulldownUserPrincipal(principal)).toEqual(principal);
    expect(
      parseNulldownUserPrincipal({
        ...principal,
        properties: { ...principal.properties, accountId: "legacy-account" },
      }),
    ).toBeNull();
  });

  it("rejects unstable identifiers rather than silently rewriting them", () => {
    expect(() => createNulldownUserSubject("user id")).toThrow(TypeError);
    expect(
      parseNulldownIdentity({
        version: 1,
        identityId: "identity_01",
        userId: "user_01",
      }),
    ).toEqual({ version: 1, identityId: "identity_01", userId: "user_01" });
    expect(
      parseNulldownIdentity({
        version: 1,
        identityId: "identity_01",
        userId: "user_01",
        token: "not-allowed",
      }),
    ).toBeNull();
  });
});

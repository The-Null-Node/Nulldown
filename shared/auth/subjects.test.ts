import {
  NULDOWN_USER_SUBJECT_TYPE,
  type NulldownIdentity,
  type NulldownUserPrincipal,
  type NulldownUserSubject,
  type NulldownUser,
} from "./subjects";
import {
  createNulldownUserSubject,
  decodeNulldownIdentity,
  decodeNulldownUser,
  decodeNulldownUserPrincipal,
  decodeNulldownUserSubject,
  encodeNulldownIdentity,
  encodeNulldownUser,
  encodeNulldownUserPrincipal,
  encodeNulldownUserSubject,
} from "./codecs/user-subject-v1";

const subjectFixture: NulldownUserSubject = { userId: "user_01" };
const userFixture: NulldownUser = { userId: "user_01" };
const identityFixture: NulldownIdentity = {
  identityId: "identity_01",
  userId: "user_01",
};

describe("Nulldown recoverable-user subjects", () => {
  it("parses only the exact v1 user subject", () => {
    expect(createNulldownUserSubject("user_01")).toEqual(subjectFixture);
    expect(decodeNulldownUserSubject(encodeNulldownUserSubject(subjectFixture))).toEqual(
      subjectFixture,
    );
    expect(
      decodeNulldownUserSubject({ version: 2, userId: "user_01" }),
    ).toBeNull();
    expect(
      decodeNulldownUserSubject({ version: 1, userId: " user_01 " }),
    ).toBeNull();
    expect(
      decodeNulldownUserSubject({
        version: 1,
        userId: "user_01",
        email: "a@b.test",
      }),
    ).toBeNull();
  });

  it("round-trips a verified principal to its canonical shape", () => {
    const principal: NulldownUserPrincipal = {
      type: NULDOWN_USER_SUBJECT_TYPE,
      properties: subjectFixture,
    };

    expect(decodeNulldownUserPrincipal(encodeNulldownUserPrincipal(principal))).toEqual(
      principal,
    );
    expect(
      decodeNulldownUserPrincipal({
        type: NULDOWN_USER_SUBJECT_TYPE,
        properties: {
          ...encodeNulldownUserSubject(subjectFixture),
          accountId: "legacy-account",
        },
      }),
    ).toBeNull();
  });

  it("rejects unstable identifiers rather than silently rewriting them", () => {
    expect(() => createNulldownUserSubject("user id")).toThrow(TypeError);
    expect(decodeNulldownUser(encodeNulldownUser(userFixture))).toEqual(userFixture);
    expect(decodeNulldownIdentity(encodeNulldownIdentity(identityFixture))).toEqual(
      identityFixture,
    );
    expect(
      decodeNulldownIdentity({
        version: 1,
        identityId: "identity_01",
        userId: "user_01",
        token: "not-allowed",
      }),
    ).toBeNull();
  });
});

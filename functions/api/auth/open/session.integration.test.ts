import { onRequestGet as callback } from "./callback";
import { onRequestGet as principal } from "./principal";
import {
  accessCookieName,
  appOrigin,
  callbackRequest,
  cookie,
  createEnv,
  FakeOpenAuthFetcher,
  loginFlow,
  MemoryD1Database,
  MemoryR2Bucket,
  refreshCookieName,
  routeContext,
  setCookies,
  transactionCookieName,
} from "./testing/bff-fixture";

describe("OpenAuth callback-to-principal integration", () => {
  it("exchanges a one-time code for an existing internal user and exposes only that principal", async () => {
    const database = new MemoryD1Database();
    database.users.add("user_recoverable");
    const bucket = new MemoryR2Bucket();
    const authority = await FakeOpenAuthFetcher.create();
    const env = createEnv(database, authority, bucket);
    const flow = await loginFlow(env, "/restore?step=confirm");
    authority.queueCode(
      "code-success",
      await authority.issueAccessToken("user_recoverable"),
    );

    const callbackResponse = await callback(
      routeContext(
        callbackRequest("code-success", flow.state, flow.transactionCookie),
        env,
      ),
    );
    const callbackCookies = setCookies(callbackResponse);

    expect(callbackResponse.status).toBe(302);
    expect(callbackResponse.headers.get("Location")).toBe(
      "/restore?step=confirm",
    );
    expect(authority.exchanges).toEqual([
      expect.objectContaining({
        code: "code-success",
        redirectUri: `${appOrigin}/api/auth/open/callback`,
      }),
    ]);
    expect(authority.exchanges[0]?.verifier).toHaveLength(64);
    expect(callbackCookies).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`${accessCookieName}=`),
        expect.stringContaining(`${refreshCookieName}=`),
        expect.stringContaining(`${transactionCookieName}=; Max-Age=0`),
      ]),
    );
    for (const value of callbackCookies) {
      expect(value).toContain("Path=/");
      expect(value).toContain("Secure");
      expect(value).toContain("HttpOnly");
      expect(value).toContain("SameSite=Lax");
      expect(value).not.toContain("Domain=");
    }
    expect(database.users).toEqual(new Set(["user_recoverable"]));
    expect(database.principalWriteCount).toBe(0);
    expect(database.legacyWriteCount).toBe(0);
    expect(bucket.writeCount).toBe(0);
    expect(
      authority.requests.every((request) => request.authorization === null),
    ).toBe(true);

    const principalResponse = await principal(
      routeContext(
        new Request(`${appOrigin}/api/auth/open/principal`, {
          headers: { Cookie: cookie(callbackCookies, accessCookieName) },
        }),
        env,
      ),
    );
    expect(principalResponse.status).toBe(200);
    await expect(principalResponse.json()).resolves.toEqual({
      authenticated: true,
      userId: "user_recoverable",
    });
  });
});

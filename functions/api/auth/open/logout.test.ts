import { onRequest as logoutRoute, onRequestPost as logout } from "./logout";
import {
  accessCookieName,
  appOrigin,
  createEnv,
  FakeOpenAuthFetcher,
  MemoryD1Database,
  refreshCookieName,
  routeContext,
  setCookies,
  transactionCookieName,
} from "./testing/bff-fixture";

describe("OpenAuth logout", () => {
  it("requires same-origin POST logout and clears only BFF cookies", async () => {
    const database = new MemoryD1Database();
    const authority = await FakeOpenAuthFetcher.create();
    const env = createEnv(database, authority);
    const invalidOrigin = await logout(
      routeContext(
        new Request(`${appOrigin}/api/auth/open/logout`, {
          method: "POST",
          headers: { Origin: "https://evil.test" },
        }),
        env,
      ),
    );
    const response = await logout(
      routeContext(
        new Request(`${appOrigin}/api/auth/open/logout`, {
          method: "POST",
          headers: { Origin: appOrigin },
        }),
        env,
      ),
    );
    const method = await logoutRoute(
      routeContext(
        new Request(`${appOrigin}/api/auth/open/logout`, { method: "GET" }),
        env,
      ),
    );

    expect(invalidOrigin.status).toBe(403);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(setCookies(response)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`${accessCookieName}=; Max-Age=0`),
        expect.stringContaining(`${refreshCookieName}=; Max-Age=0`),
        expect.stringContaining(`${transactionCookieName}=; Max-Age=0`),
      ]),
    );
    expect(method.status).toBe(405);
  });
});

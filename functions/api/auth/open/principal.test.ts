import { onRequestGet as principal } from "./principal";
import {
  accessCookieName,
  appOrigin,
  createEnv,
  FakeOpenAuthFetcher,
  MemoryD1Database,
  refreshCookieName,
  routeContext,
  setCookies,
} from "./testing/bff-fixture";

describe("OpenAuth principal and refresh session", () => {
  it.each(["network", "503", "429", "408", "database"])(
    "preserves cookies when a dependency is unavailable (%s)",
    async (failure) => {
      const database = new MemoryD1Database();
      database.users.add("user_recoverable");
      const authority = await FakeOpenAuthFetcher.create();
      const token = await authority.issueAccessToken("user_recoverable", {
        expiresAt:
          Math.floor(Date.now() / 1000) + (failure === "database" ? 300 : -1),
      });
      const env = createEnv(database, authority);
      env.OPENAUTH_AUTHORITY = {
        async fetch(input, init) {
          const url = new URL(
            input instanceof Request ? input.url : String(input),
          );
          if (url.pathname === "/token") {
            if (failure === "network")
              throw new Error("Temporary transport outage");
            return Response.json(
              { error: "temporarily_unavailable" },
              { status: Number(failure) },
            );
          }
          return authority.fetch(input, init);
        },
      };
      if (failure === "database") {
        database.first = () => {
          throw new Error("Temporary database outage");
        };
      }
      const response = await principal(
        routeContext(
          new Request(`${appOrigin}/api/auth/open/principal`, {
            headers: {
              Cookie: `${accessCookieName}=${token}; ${refreshCookieName}=refresh-preserved`,
            },
          }),
          env,
        ),
      );
      expect(response.status).toBe(503);
      expect(setCookies(response)).toEqual([]);
      await expect(response.json()).resolves.toEqual({
        error: "open_auth_unavailable",
        reason: "authority_or_principal_store_unavailable",
      });
    },
  );

  it("returns anonymous for invalid access cookies without returning refresh material", async () => {
    const database = new MemoryD1Database();
    const authority = await FakeOpenAuthFetcher.create();
    const env = createEnv(database, authority);
    const response = await principal(
      routeContext(
        new Request(`${appOrigin}/api/auth/open/principal`, {
          headers: {
            Cookie: `${accessCookieName}=forged; ${refreshCookieName}=secret-refresh`,
          },
        }),
        env,
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ authenticated: false });
    expect(response.headers.get("Set-Cookie")).not.toContain("secret-refresh");
  });

  it("refreshes an expired access cookie server-side and rotates only BFF cookies", async () => {
    const database = new MemoryD1Database();
    database.users.add("user_recoverable");
    const authority = await FakeOpenAuthFetcher.create();
    const env = createEnv(database, authority);
    const expiredAccess = await authority.issueAccessToken("user_recoverable", {
      expiresAt: Math.floor(Date.now() / 1000) - 1,
    });
    const refreshedAccess =
      await authority.issueAccessToken("user_recoverable");
    authority.queueRefresh("refresh-before", refreshedAccess, "refresh-after");

    const response = await principal(
      routeContext(
        new Request(`${appOrigin}/api/auth/open/principal`, {
          headers: {
            Cookie: `${accessCookieName}=${expiredAccess}; ${refreshCookieName}=refresh-before`,
          },
        }),
        env,
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      authenticated: true,
      userId: "user_recoverable",
    });
    expect(authority.refreshes).toEqual(["refresh-before"]);
    expect(setCookies(response)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`${accessCookieName}=${refreshedAccess}`),
        expect.stringContaining(`${refreshCookieName}=refresh-after`),
        expect.stringContaining("Max-Age=31536000"),
      ]),
    );
    expect(database.principalWriteCount).toBe(0);
    expect(database.legacyWriteCount).toBe(0);
  });

  it("rejects an issuer subject for an unknown internal user without writes", async () => {
    const database = new MemoryD1Database();
    const authority = await FakeOpenAuthFetcher.create();
    const env = createEnv(database, authority);
    const token = await authority.issueAccessToken("user_unknown");

    const response = await principal(
      routeContext(
        new Request(`${appOrigin}/api/auth/open/principal`, {
          headers: { Cookie: `${accessCookieName}=${token}` },
        }),
        env,
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ authenticated: false });
    expect(database.users).toEqual(new Set());
    expect(database.principalWriteCount).toBe(0);
    expect(database.legacyWriteCount).toBe(0);
  });
});

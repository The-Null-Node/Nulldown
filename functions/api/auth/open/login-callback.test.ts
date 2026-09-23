import type { D1Database } from "@cloudflare/workers-types";

import {
  onRequest as callbackRoute,
  onRequestGet as callback,
} from "./callback";
import { onRequestGet as login } from "./login";
import {
  appOrigin,
  callbackRequest,
  createEnv,
  FakeOpenAuthFetcher,
  loginFlow,
  MemoryD1Database,
  routeContext,
  setCookies,
  transactionCookieName,
} from "./testing/bff-fixture";

describe("OpenAuth login and callback transactions", () => {
  it("fails closed with a structured 503 when authority configuration is absent", async () => {
    const response = await login(
      routeContext(new Request(`${appOrigin}/api/auth/open/login`), {
        DB: new MemoryD1Database() as unknown as D1Database,
      }),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "open_auth_unavailable",
      reason: "authority_configuration_missing",
    });
  });

  it("rejects malformed return paths before creating a transaction", async () => {
    const database = new MemoryD1Database();
    const authority = await FakeOpenAuthFetcher.create();
    const response = await login(
      routeContext(
        new Request(
          `${appOrigin}/api/auth/open/login?returnTo=https%3A%2F%2Fevil.test`,
        ),
        createEnv(database, authority),
      ),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_return_to",
    });
    expect(database.transactions.size).toBe(0);
  });

  it("stores only a state hash and rejects mismatched state before code exchange", async () => {
    const database = new MemoryD1Database();
    const authority = await FakeOpenAuthFetcher.create();
    const env = createEnv(database, authority);
    const flow = await loginFlow(env, "/library?view=private");

    expect(flow.state).toHaveLength(86);
    expect(flow.nonce).toHaveLength(43);
    expect(flow.state.startsWith(flow.nonce)).toBe(true);
    expect(flow.transactionSetCookie).toContain("Path=/");
    expect(flow.transactionSetCookie).toContain("Secure");
    expect(flow.transactionSetCookie).toContain("HttpOnly");
    expect(flow.transactionSetCookie).toContain("SameSite=Lax");
    expect(flow.transactionSetCookie).not.toContain("Domain=");
    expect([...database.transactions.keys()]).not.toContain(flow.state);
    expect(database.transactions.size).toBe(1);

    const mismatchedNonce = `${flow.state.startsWith("x") ? "y" : "x"}${flow.state.slice(1)}`;
    const response = await callback(
      routeContext(
        callbackRequest(
          "code-state-mismatch",
          mismatchedNonce,
          flow.transactionCookie,
        ),
        env,
      ),
    );
    const method = await callbackRoute(
      routeContext(
        new Request(`${appOrigin}/api/auth/open/callback`, {
          method: "POST",
        }),
        env,
      ),
    );

    expect(response.status).toBe(400);
    expect(authority.exchanges).toEqual([]);
    expect(database.transactions.size).toBe(1);
    expect(method.status).toBe(405);
  });

  it("rejects a callback whose BFF transaction cookie lacks the PKCE verifier", async () => {
    const database = new MemoryD1Database();
    const authority = await FakeOpenAuthFetcher.create();
    const env = createEnv(database, authority);
    const flow = await loginFlow(env);
    const [, encoded] = flow.transactionCookie.split("=");
    const altered = JSON.parse(
      Buffer.from(encoded, "base64url").toString(),
    ) as Record<string, unknown>;
    delete altered.verifier;
    const missingVerifierCookie = `${transactionCookieName}=${Buffer.from(JSON.stringify(altered)).toString("base64url")}`;

    const response = await callback(
      routeContext(
        callbackRequest(
          "code-missing-verifier",
          flow.state,
          missingVerifierCookie,
        ),
        env,
      ),
    );

    expect(response.status).toBe(400);
    expect(authority.exchanges).toEqual([]);
    expect(database.transactions.size).toBe(1);
  });

  it("accepts the same pre-existing internal user across callbacks without creating records", async () => {
    const database = new MemoryD1Database();
    database.users.add("user_same_identity");
    const authority = await FakeOpenAuthFetcher.create();
    const env = createEnv(database, authority);
    const first = await loginFlow(env);
    const second = await loginFlow(env);
    const token = await authority.issueAccessToken("user_same_identity");
    authority.queueCode("code-first", token);
    authority.queueCode("code-second", token);

    expect(
      (
        await callback(
          routeContext(
            callbackRequest("code-first", first.state, first.transactionCookie),
            env,
          ),
        )
      ).status,
    ).toBe(302);
    expect(
      (
        await callback(
          routeContext(
            callbackRequest(
              "code-second",
              second.state,
              second.transactionCookie,
            ),
            env,
          ),
        )
      ).status,
    ).toBe(302);
    expect(database.users).toEqual(new Set(["user_same_identity"]));
    expect(database.principalWriteCount).toBe(0);
  });

  it("rejects an unknown issuer subject during callback without manufacturing user records", async () => {
    const database = new MemoryD1Database();
    const authority = await FakeOpenAuthFetcher.create();
    const env = createEnv(database, authority);
    const flow = await loginFlow(env);
    authority.queueCode(
      "code-unknown-user",
      await authority.issueAccessToken("user_unknown"),
    );

    const response = await callback(
      routeContext(
        callbackRequest(
          "code-unknown-user",
          flow.state,
          flow.transactionCookie,
        ),
        env,
      ),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_principal",
    });
    expect(database.users).toEqual(new Set());
    expect(database.principalWriteCount).toBe(0);
    expect(database.legacyWriteCount).toBe(0);
  });

  it("consumes each callback transaction before exchange so replay cannot call the authority twice", async () => {
    const database = new MemoryD1Database();
    database.users.add("user_01");
    const authority = await FakeOpenAuthFetcher.create();
    const env = createEnv(database, authority);
    const flow = await loginFlow(env);
    authority.queueCode("code-replay", await authority.issueAccessToken());
    const request = callbackRequest(
      "code-replay",
      flow.state,
      flow.transactionCookie,
    );

    expect((await callback(routeContext(request, env))).status).toBe(302);
    expect((await callback(routeContext(request, env))).status).toBe(400);
    expect(authority.exchanges).toHaveLength(1);
    expect(database.transactions.size).toBe(0);
  });

  it.each([
    [
      "expired",
      async (authority: FakeOpenAuthFetcher) =>
        authority.issueAccessToken("user_01", {
          expiresAt: Math.floor(Date.now() / 1000) - 1,
        }),
    ],
    [
      "forged",
      async (authority: FakeOpenAuthFetcher) =>
        `${await authority.issueAccessToken()}x`,
    ],
    [
      "wrong issuer",
      async (authority: FakeOpenAuthFetcher) =>
        authority.issueAccessToken("user_01", {
          issuer: "https://other-issuer.test",
        }),
    ],
    [
      "wrong audience",
      async (authority: FakeOpenAuthFetcher) =>
        authority.issueAccessToken("user_01", { audience: "other-client" }),
    ],
  ])(
    "rejects %s access tokens without creating a user principal",
    async (_name, createToken) => {
      const database = new MemoryD1Database();
      const authority = await FakeOpenAuthFetcher.create();
      const env = createEnv(database, authority);
      const flow = await loginFlow(env);
      authority.queueCode("code-invalid-token", await createToken(authority));

      const response = await callback(
        routeContext(
          callbackRequest(
            "code-invalid-token",
            flow.state,
            flow.transactionCookie,
          ),
          env,
        ),
      );

      expect(response.status).toBe(401);
      expect(database.users.size).toBe(0);
      expect(database.principalWriteCount).toBe(0);
      expect(setCookies(response)).toEqual(
        expect.arrayContaining([
          expect.stringContaining(`${transactionCookieName}=; Max-Age=0`),
        ]),
      );
    },
  );
});

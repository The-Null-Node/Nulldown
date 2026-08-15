import { createClient } from "@openauthjs/openauth/client";
import { MemoryStorage } from "@openauthjs/openauth/storage/memory";

import {
  createNulldownOpenAuthApplication,
  normalizeCodeAddress,
  nulldownOpenAuthSubjects,
  parseOpenAuthClientRegistrations,
} from "./application";
import openAuthWorker from "./worker";

const issuerUrl = "https://issuer.test";
const clientId = "nulldown-browser-v1";
const redirectUri = "https://app.test/auth/callback";

const cookieFrom = (response: Response): string => {
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("Expected an OpenAuth session cookie.");
  return cookie;
};

const createHarness = () => {
  const deliveries: Array<{ address: string; code: string }> = [];
  const resolverAddresses: string[] = [];
  const app = createNulldownOpenAuthApplication({
    storage: MemoryStorage(),
    clients: [{ clientId, redirectUri }],
    codeDelivery: {
      async sendCode(input) {
        deliveries.push({ ...input });
      },
    },
    userIdResolver: {
      async resolveUserId({ address }) {
        resolverAddresses.push(address);
        return "user_01";
      },
    },
  });

  const dispatch = (input: RequestInfo | URL, init?: RequestInit) =>
    app.fetch(new Request(input, init));
  const client = createClient({ clientID: clientId, issuer: issuerUrl, fetch: dispatch });

  return { app, client, deliveries, resolverAddresses };
};

const issueAuthorizationCode = async () => {
  const harness = createHarness();
  const authorization = await harness.client.authorize(redirectUri, "code", {
    pkce: true,
  });
  const authorize = await harness.app.fetch(new Request(authorization.url));
  expect(authorize.status).toBe(302);

  const authorizationCookie = cookieFrom(authorize);
  const providerStart = await harness.app.fetch(
    new Request(`${issuerUrl}${authorize.headers.get("location")}`, {
      headers: { cookie: authorizationCookie },
    }),
  );
  expect(providerStart.status).toBe(200);

  const providerCookie = cookieFrom(providerStart);
  const requestCode = await harness.app.fetch(
    new Request(`${issuerUrl}/code/authorize`, {
      method: "POST",
      headers: {
        cookie: `${authorizationCookie}; ${providerCookie}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ action: "request", address: "  User@Example.TEST  " }),
    }),
  );
  expect(requestCode.status).toBe(200);

  const codeCookie = cookieFrom(requestCode);
  const verify = await harness.app.fetch(
    new Request(`${issuerUrl}/code/authorize`, {
      method: "POST",
      headers: {
        cookie: `${authorizationCookie}; ${codeCookie}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        action: "verify",
        code: harness.deliveries[0]?.code ?? "",
      }),
    }),
  );
  expect(verify.status).toBe(302);

  const callback = new URL(verify.headers.get("location") ?? "", redirectUri);
  const code = callback.searchParams.get("code");
  if (!code) throw new Error("Expected authorization code redirect.");

  return { ...harness, authorization, callback, code };
};

describe("Nulldown OpenAuth Worker foundation", () => {
  it("normalizes code addresses through the injected fake without an external invocation", async () => {
    const originalFetch = globalThis.fetch;
    const externalFetchCalls: unknown[][] = [];
    globalThis.fetch = (...args) => {
      externalFetchCalls.push(args);
      return Promise.reject(new Error("Unexpected external fetch."));
    };

    try {
      const flow = await issueAuthorizationCode();

      expect(normalizeCodeAddress("  User@Example.TEST  ")).toBe("user@example.test");
      expect(flow.deliveries).toHaveLength(1);
      expect(flow.deliveries[0]?.address).toBe("user@example.test");
      expect(flow.resolverAddresses).toEqual(["user@example.test"]);
      expect(externalFetchCalls).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("runs the actual authorization-code and PKCE exchange in process", async () => {
    const flow = await issueAuthorizationCode();

    expect(flow.callback.searchParams.get("state")).toBe(flow.authorization.challenge.state);
    const exchanged = await flow.client.exchange(
      flow.code,
      redirectUri,
      flow.authorization.challenge.verifier,
    );
    expect(exchanged.err).toBe(false);
    if (exchanged.err) throw exchanged.err;

    const verified = await flow.client.verify(
      nulldownOpenAuthSubjects,
      exchanged.tokens.access,
    );
    expect(verified).not.toHaveProperty("err");
    if ("err" in verified) throw verified.err;
    expect(verified.subject).toEqual({
      type: "nulldown-user",
      properties: { version: 1, userId: "user_01" },
    });
  });

  it("rejects malformed state, non-PKCE flows, and non-exact client redirects", async () => {
    const { app, client } = createHarness();
    const authorization = await client.authorize(redirectUri, "code", { pkce: true });
    const malformedState = new URL(authorization.url);
    malformedState.searchParams.set("state", "short");
    expect((await app.fetch(new Request(malformedState))).status).toBe(400);

    const tokenFlow = new URL(authorization.url);
    tokenFlow.searchParams.set("response_type", "token");
    expect((await app.fetch(new Request(tokenFlow))).status).toBe(400);

    const unlistedRedirect = new URL(authorization.url);
    unlistedRedirect.searchParams.set("redirect_uri", "https://other.test/auth/callback");
    expect((await app.fetch(new Request(unlistedRedirect))).status).toBe(403);
  });

  it("rejects invalid and reused authorization codes when PKCE does not match", async () => {
    const flow = await issueAuthorizationCode();
    const wrongVerifier = "a".repeat(flow.authorization.challenge.verifier?.length ?? 43);
    const rejected = await flow.client.exchange(flow.code, redirectUri, wrongVerifier);
    expect(rejected.err).not.toBe(false);

    const reused = await flow.client.exchange(
      flow.code,
      redirectUri,
      flow.authorization.challenge.verifier,
    );
    expect(reused.err).not.toBe(false);

    const unknown = await flow.client.exchange("unknown-code", redirectUri, wrongVerifier);
    expect(unknown.err).not.toBe(false);
  });

  it("fails closed when production KV or code-delivery bindings are absent", async () => {
    const request = new Request(`${issuerUrl}/.well-known/oauth-authorization-server`);
    const withoutKv = await openAuthWorker.fetch(request, {});
    expect(withoutKv.status).toBe(503);
    await expect(withoutKv.text()).resolves.toContain("OPENAUTH_KV");

    const withoutDelivery = await openAuthWorker.fetch(request, {
      OPENAUTH_KV: {} as KVNamespace,
    });
    expect(withoutDelivery.status).toBe(503);
    await expect(withoutDelivery.text()).resolves.toContain("OPENAUTH_CODE_DELIVERY");

    const withoutResolver = await openAuthWorker.fetch(request, {
      OPENAUTH_KV: {} as KVNamespace,
      OPENAUTH_CODE_DELIVERY: { async sendCode() {} },
    });
    expect(withoutResolver.status).toBe(503);
    await expect(withoutResolver.text()).resolves.toContain("OPENAUTH_IDENTITY_RESOLVER");
  });

  it("parses only explicit canonical client registrations", () => {
    expect(
      parseOpenAuthClientRegistrations([{ clientId, redirectUri }]),
    ).toEqual([{ clientId, redirectUri }]);
    expect(
      parseOpenAuthClientRegistrations([
        { clientId, redirectUri: "https://app.test/auth/callback/../callback" },
      ]),
    ).toBeNull();
    expect(parseOpenAuthClientRegistrations([{ clientId, redirectUri: "http://app.test/cb" }])).toBeNull();
  });
});

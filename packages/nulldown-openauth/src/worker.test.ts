import { createClient } from "@openauthjs/openauth/client";
import { MemoryStorage } from "@openauthjs/openauth/storage/memory";
import type { D1Database } from "@cloudflare/workers-types";

import {
  createNulldownOpenAuthApplication,
  normalizeCodeAddress,
  nulldownOpenAuthSubjects,
  parseOpenAuthClientRegistrations,
} from "./application";
import openAuthWorker from "./worker";
import type { NulldownOpenAuthWorkerEnvironment } from "./worker";

const issuerUrl = "https://issuer.test";
const clientId = "nulldown-browser-v1";
const redirectUri = "https://app.test/auth/callback";

interface EmailMessage {
  to: string;
  from: string;
  subject: string;
  html: string;
  text: string;
}

class MemoryKv {
  readonly putKeys: string[] = [];
  private readonly values = new Map<string, { value: string; expiresAt: number | null }>();
  private now = Date.now();

  async get(key: string, type?: "json"): Promise<unknown> {
    const entry = this.values.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= this.now) {
      this.values.delete(key);
      return null;
    }
    return type === "json" ? JSON.parse(entry.value) : entry.value;
  }

  async put(
    key: string,
    value: string,
    options?: Readonly<{ expirationTtl?: number }>,
  ): Promise<void> {
    this.putKeys.push(key);
    this.values.set(key, {
      value,
      expiresAt: options?.expirationTtl ? this.now + options.expirationTtl * 1000 : null,
    });
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  async list(options: Readonly<{ prefix?: string }> = {}): Promise<{
    keys: Array<{ name: string }>;
    list_complete: true;
  }> {
    const prefix = options.prefix ?? "";
    const keys = [] as Array<{ name: string }>;
    for (const key of this.values.keys()) {
      if ((await this.get(key)) !== null && key.startsWith(prefix)) keys.push({ name: key });
    }
    return { keys, list_complete: true };
  }

  advance(seconds: number): void {
    this.now += seconds * 1000;
  }
}

class MemoryEmail {
  readonly messages: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<{ messageId: string }> {
    this.messages.push({ ...message });
    return { messageId: `message-${this.messages.length}` };
  }
}

class MemoryD1Statement {
  private params: unknown[] = [];

  constructor(
    private readonly database: MemoryD1,
    private readonly sql: string,
  ) {}

  bind(...params: unknown[]): this {
    this.params = params;
    return this;
  }

  async run(): Promise<{ success: true }> {
    this.database.run(this.sql, this.params);
    return { success: true };
  }

  async first<T>(): Promise<T | null> {
    return (await this.database.first(this.sql, this.params)) as T | null;
  }
}

class MemoryD1 {
  readonly users = new Set<string>();
  readonly identities = new Map<string, string>();
  legacyWriteCount = 0;
  failCandidateCleanup = false;
  holdInitialIdentityReads = false;
  private initialIdentityReadCount = 0;
  private releaseInitialIdentityReads: (() => void) | null = null;

  prepare(sql: string): MemoryD1Statement {
    return new MemoryD1Statement(this, sql);
  }

  run(sql: string, params: unknown[]): void {
    if (/\b(?:accounts|branches|drops)\b/i.test(sql) && !sql.includes("auth_")) {
      this.legacyWriteCount += 1;
    }
    if (sql.includes("INSERT INTO auth_external_identities")) {
      const key = [params[0], params[1], params[2]].map(String).join("\u0000");
      if (!this.identities.has(key)) this.identities.set(key, String(params[3]));
      return;
    }
    if (sql.includes("DELETE FROM auth_users")) {
      if (this.failCandidateCleanup) throw new Error("Cleanup unavailable.");
      const userId = String(params[0]);
      if (![...this.identities.values()].includes(userId)) this.users.delete(userId);
    }
  }

  async first(sql: string, params: unknown[]): Promise<unknown> {
    if (sql.includes("INSERT INTO auth_users")) {
      const userId = String(params[0]);
      if (this.users.has(userId)) return null;
      this.users.add(userId);
      return { user_id: userId };
    }
    if (sql.includes("FROM auth_external_identities")) {
      if (this.holdInitialIdentityReads && this.identities.size === 0) {
        this.initialIdentityReadCount += 1;
        if (this.initialIdentityReadCount === 1) {
          await new Promise<void>((resolve) => {
            this.releaseInitialIdentityReads = resolve;
          });
        } else if (this.initialIdentityReadCount === 2) {
          this.releaseInitialIdentityReads?.();
        }
      }
      const key = [params[0], params[1], params[2]].map(String).join("\u0000");
      const userId = this.identities.get(key);
      return userId ? { user_id: userId } : null;
    }
    return null;
  }
}

const createWorkerHarness = () => {
  const kv = new MemoryKv();
  const database = new MemoryD1();
  const email = new MemoryEmail();
  const env: NulldownOpenAuthWorkerEnvironment = {
    OPENAUTH_KV: kv as unknown as KVNamespace,
    DB: database as unknown as D1Database,
    EMAIL: email,
    OPENAUTH_ISSUER_URL: issuerUrl,
    OPENAUTH_EMAIL_FROM: "  NoReply@Example.TEST  ",
    OPENAUTH_CLIENTS_JSON: JSON.stringify([{ clientId, redirectUri }]),
  };
  const dispatch = (input: RequestInfo | URL, init?: RequestInit) =>
    openAuthWorker.fetch(input instanceof Request ? input : new Request(input, init), env);
  const client = createClient({ clientID: clientId, issuer: issuerUrl, fetch: dispatch });

  return { client, database, dispatch, email, env, kv };
};

const cookieFrom = (response: Response): string => {
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("Expected an OpenAuth session cookie.");
  return cookie;
};

const startWorkerCodeFlow = async (
  harness: ReturnType<typeof createWorkerHarness>,
  address = "  User@Example.TEST  ",
) => {
  const authorization = await harness.client.authorize(redirectUri, "code", { pkce: true });
  const authorize = await harness.dispatch(authorization.url);
  expect(authorize.status).toBe(302);

  const authorizationCookie = cookieFrom(authorize);
  const providerStart = await harness.dispatch(
    new Request(`${issuerUrl}${authorize.headers.get("location")}`, {
      headers: { cookie: authorizationCookie },
    }),
  );
  expect(providerStart.status).toBe(200);

  const providerCookie = cookieFrom(providerStart);
  const requestCode = await harness.dispatch(
    new Request(`${issuerUrl}/code/authorize`, {
      method: "POST",
      headers: {
        cookie: `${authorizationCookie}; ${providerCookie}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ action: "request", address }),
    }),
  );
  expect(requestCode.status).toBe(200);

  const message = harness.email.messages.at(-1);
  const code = message?.text.match(/\b\d{6}\b/u)?.[0];
  if (!message || !code) throw new Error("Expected a verification email containing a code.");

  return {
    authorization,
    authorizationCookie,
    code,
    codeCookie: cookieFrom(requestCode),
    message,
  };
};

const verifyWorkerCodeFlow = async (
  harness: ReturnType<typeof createWorkerHarness>,
  flow: Awaited<ReturnType<typeof startWorkerCodeFlow>>,
) => {
  const verify = await harness.dispatch(
    new Request(`${issuerUrl}/code/authorize`, {
      method: "POST",
      headers: {
        cookie: `${flow.authorizationCookie}; ${flow.codeCookie}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ action: "verify", code: flow.code }),
    }),
  );
  expect(verify.status).toBe(302);

  const callback = new URL(verify.headers.get("location") ?? "", redirectUri);
  const code = callback.searchParams.get("code");
  if (!code) throw new Error("Expected authorization code redirect.");
  return { callback, code };
};

const exchangeWorkerCodeFlow = async (
  harness: ReturnType<typeof createWorkerHarness>,
  flow: Awaited<ReturnType<typeof startWorkerCodeFlow>>,
) => {
  const callback = await verifyWorkerCodeFlow(harness, flow);
  const exchanged = await harness.client.exchange(
    callback.code,
    redirectUri,
    flow.authorization.challenge.verifier,
  );
  expect(exchanged.err).toBe(false);
  if (exchanged.err) throw exchanged.err;

  const verified = await harness.client.verify(
    nulldownOpenAuthSubjects,
    exchanged.tokens.access,
  );
  expect(verified).not.toHaveProperty("err");
  if ("err" in verified) throw verified.err;
  return verified.subject.properties.userId;
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

  it("uses native KV, D1, and Email bindings for a normalized PKCE sign-in without external fetches", async () => {
    const originalFetch = globalThis.fetch;
    const externalFetchCalls: unknown[][] = [];
    globalThis.fetch = (...args) => {
      externalFetchCalls.push(args);
      return Promise.reject(new Error("Unexpected external fetch."));
    };

    try {
      const harness = createWorkerHarness();
      const flow = await startWorkerCodeFlow(harness);
      const userId = await exchangeWorkerCodeFlow(harness, flow);
      const identityKey = [issuerUrl, "email", "user@example.test"].join("\u0000");

      expect(flow.message).toEqual({
        to: "user@example.test",
        from: "noreply@example.test",
        subject: "Your Nulldown verification code",
        text: expect.stringContaining(flow.code),
        html: expect.stringContaining(`<strong>${flow.code}</strong>`),
      });
      expect(userId).toMatch(/^user_[A-Za-z0-9_-]+$/u);
      expect(userId).not.toContain("user@example.test");
      expect(harness.database.identities.get(identityKey)).toBe(userId);
      expect(harness.database.users).toEqual(new Set([userId]));
      expect(harness.database.legacyWriteCount).toBe(0);
      expect(harness.kv.putKeys.some((key) => key.includes("user@example.test"))).toBe(false);
      expect(externalFetchCalls).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("suppresses rapid code resends without invalidating the already delivered code", async () => {
    const harness = createWorkerHarness();
    const flow = await startWorkerCodeFlow(harness);

    const resend = await harness.dispatch(
      new Request(`${issuerUrl}/code/authorize`, {
        method: "POST",
        headers: {
          cookie: `${flow.authorizationCookie}; ${flow.codeCookie}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ action: "resend", address: "user@example.test" }),
      }),
    );

    expect(resend.status).toBe(429);
    expect(resend.headers.get("Cache-Control")).toBe("no-store");
    expect(harness.email.messages).toHaveLength(1);
    await expect(verifyWorkerCodeFlow(harness, flow)).resolves.toEqual({
      callback: expect.any(URL),
      code: expect.any(String),
    });
  });

  it("refreshes a native issuer session without changing the resolved user", async () => {
    const harness = createWorkerHarness();
    const flow = await startWorkerCodeFlow(harness);
    const callback = await verifyWorkerCodeFlow(harness, flow);
    const exchanged = await harness.client.exchange(
      callback.code,
      redirectUri,
      flow.authorization.challenge.verifier,
    );
    expect(exchanged.err).toBe(false);
    if (exchanged.err) throw exchanged.err;

    const refreshed = await harness.client.refresh(exchanged.tokens.refresh);
    expect(refreshed.err).toBe(false);
    if (refreshed.err || !refreshed.tokens) throw new Error("Expected refreshed OpenAuth tokens.");

    const verified = await harness.client.verify(
      nulldownOpenAuthSubjects,
      refreshed.tokens.access,
    );
    expect(verified).not.toHaveProperty("err");
    if ("err" in verified) throw verified.err;
    expect(verified.subject.properties.userId).toMatch(/^user_[A-Za-z0-9_-]+$/u);
    expect(harness.database.users).toEqual(new Set([verified.subject.properties.userId]));
  });

  it("reuses the same D1 identity after the cooldown expires", async () => {
    const harness = createWorkerHarness();
    const first = await startWorkerCodeFlow(harness);
    const firstUserId = await exchangeWorkerCodeFlow(harness, first);
    harness.kv.advance(61);
    const second = await startWorkerCodeFlow(harness, "user@example.test");
    const secondUserId = await exchangeWorkerCodeFlow(harness, second);

    expect(secondUserId).toBe(firstUserId);
    expect(harness.database.users).toEqual(new Set([firstUserId]));
    expect(harness.database.identities.size).toBe(1);
    expect(harness.email.messages).toHaveLength(2);
  });

  it("keeps one external identity and cleans the losing user candidate during concurrent verification", async () => {
    const harness = createWorkerHarness();
    const first = await startWorkerCodeFlow(harness);
    harness.kv.advance(61);
    const second = await startWorkerCodeFlow(harness, "user@example.test");

    await Promise.all([verifyWorkerCodeFlow(harness, first), verifyWorkerCodeFlow(harness, second)]);

    const winner = harness.database.identities.get(
      [issuerUrl, "email", "user@example.test"].join("\u0000"),
    );
    expect(winner).toBeDefined();
    expect(harness.database.users).toEqual(new Set([winner]));
    expect(harness.database.legacyWriteCount).toBe(0);
  });

  it("keeps an unreferenced candidate benign when concurrent cleanup is unavailable", async () => {
    const harness = createWorkerHarness();
    const first = await startWorkerCodeFlow(harness);
    harness.kv.advance(61);
    const second = await startWorkerCodeFlow(harness, "user@example.test");
    harness.database.failCandidateCleanup = true;
    harness.database.holdInitialIdentityReads = true;

    await Promise.all([verifyWorkerCodeFlow(harness, first), verifyWorkerCodeFlow(harness, second)]);

    const winner = harness.database.identities.get(
      [issuerUrl, "email", "user@example.test"].join("\u0000"),
    );
    expect(winner).toBeDefined();
    expect(harness.database.users.size).toBe(2);
    expect([...harness.database.users].filter((userId) => userId !== winner)).toHaveLength(1);
    expect(harness.database.legacyWriteCount).toBe(0);
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

  it("fails closed when a required native binding or deployment value is missing or invalid", async () => {
    const request = new Request(`${issuerUrl}/.well-known/oauth-authorization-server`);
    const withoutKv = await openAuthWorker.fetch(request, {});
    expect(withoutKv.status).toBe(503);
    await expect(withoutKv.text()).resolves.toContain("storage_binding_unavailable");

    const withoutDatabase = await openAuthWorker.fetch(request, {
      OPENAUTH_KV: new MemoryKv() as unknown as KVNamespace,
    });
    expect(withoutDatabase.status).toBe(503);
    await expect(withoutDatabase.text()).resolves.toContain("principal_store_unavailable");

    const harness = createWorkerHarness();
    const cases: Array<[string, NulldownOpenAuthWorkerEnvironment]> = [
      ["email", { ...harness.env, EMAIL: undefined }],
      ["issuer", { ...harness.env, OPENAUTH_ISSUER_URL: "https://issuer.test/" }],
      ["sender", { ...harness.env, OPENAUTH_EMAIL_FROM: "not-an-address" }],
      ["clients", { ...harness.env, OPENAUTH_CLIENTS_JSON: "{}" }],
    ];

    for (const [name, env] of cases) {
      const response = await openAuthWorker.fetch(request, env);
      expect(response.status).toBe(503);
      await expect(response.text()).resolves.toContain("OpenAuth service unavailable");
      expect(name).toBeTruthy();
    }
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

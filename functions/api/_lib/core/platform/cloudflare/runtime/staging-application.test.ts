import { jest } from "@jest/globals";
import type {
  D1Database,
  IncomingRequestCfProperties,
  R2Bucket,
} from "@cloudflare/workers-types";
import {
  fetchStagingApplication,
  type StagingApplicationDependencies,
} from "../../../../../../../packages/nulldown-state-plane/src/staging-api";
import stagingApi from "../../../../../../../packages/nulldown-state-plane/src/staging-api";
import { createStagingBranchApplication } from "../../../../../../../packages/nulldown-state-plane/src/staging-selection";
import type { BranchStateRpcStub } from "../../../../../../../packages/nulldown-state-plane/src/shard-router";
import { BranchStateError } from "../../../../../../../shared/drop/branch-state";
import { serializeAccountProof } from "../../../../accounts/identity/proof";
import { ACCOUNT_RECORD_PREFIX } from "../../../../accounts/identity/repository";
import { verifyAccountSessionToken } from "../../../../accounts/session/token";
import { MemoryR2Bucket } from "../../../../drops/testing/storage-fixture";
import { MemoryD1Database } from "../../../d1/testing/metadata-fixture";

class AccountDatabase extends MemoryD1Database {
  libraryEntry: Record<string, unknown> | null = null;

  override first(
    sql: string,
    params: unknown[],
  ): Record<string, unknown> | null {
    if (sql.includes("FROM account_library_entries")) return this.libraryEntry;
    return super.first(sql, params);
  }

  override run(sql: string, params: unknown[]): void {
    if (!sql.includes("INSERT INTO accounts")) return super.run(sql, params);
    this.sqlLog.push(sql);
    const id = String(params[0]);
    if (sql.includes("DO NOTHING") && this.accounts.has(id)) return;
    this.accounts.set(id, {
      account_id: id,
      signing_public_jwk: String(params[1]),
      encryption_kid: params[2] === null ? null : String(params[2]),
      encryption_public_jwk: params[3] === null ? null : String(params[3]),
      created_at: Number(params[4]),
      updated_at: Number(params[5]),
    });
  }
}

const unexpectedRpc = async (): Promise<never> => {
  throw Error("unexpected service call");
};

const setup = () => {
  const bucket = new MemoryR2Bucket();
  const db = new AccountDatabase();
  const pending: Promise<unknown>[] = [];
  const state: BranchStateRpcStub = {
    append: unexpectedRpc,
    readHead: unexpectedRpc,
    readContent: unexpectedRpc,
    readEvents: unexpectedRpc,
  };
  const bindings: StagingApplicationDependencies = {
    ENVIRONMENT: "staging",
    // These doubles exercise the real HTTP/application boundary; native binding
    // contracts are covered separately by the maintained workerd acceptance.
    R2_BUCKET: bucket as unknown as R2Bucket,
    DB: db as unknown as D1Database,
    STATE_PLANE: state,
    ACCOUNT_AUTH_SECRET: "isolated-staging-test-account-secret",
    PROVIDER_ENCRYPTION_PRIVATE_JWK: "configured-by-deployment",
    PROVIDER_SIGNING_PRIVATE_JWK: "configured-by-deployment",
    LOG_LEVEL: "silent",
  };
  const execution = {
    waitUntil(promise: Promise<unknown>) {
      // Assert the gateway retains the receiver when forwarding platform hooks.
      expect(this).toBe(execution);
      pending.push(promise);
    },
  };
  const request = async (path: string, init?: RequestInit) => {
    const response = await fetchStagingApplication(
      new Request<unknown, IncomingRequestCfProperties>(
        `https://staging.example${path}`,
        { ...init, cf: undefined },
      ),
      bindings,
      execution,
    );
    await Promise.all(pending);
    return response;
  };
  return { bucket, db, pending, bindings, request, execution };
};

const proof = async (
  accountId = "staging-signed-account",
  signedAt = Date.now(),
) => {
  const keys = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  if (!("privateKey" in keys)) throw Error("Expected ECDSA key pair");
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    keys.privateKey,
    new TextEncoder().encode(serializeAccountProof(accountId, signedAt)),
  );
  return {
    accountId,
    signedAt,
    signingPublicJwk: await crypto.subtle.exportKey("jwk", keys.publicKey),
    signature: Buffer.from(signature).toString("base64url"),
  };
};

const jsonPost = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const authenticatedResolve = async () => {
  const context = setup();
  const account = await proof("staging-rpc-account");
  const session = await context.request("/api/auth/session", jsonPost(account));
  const { token } = (await session.json()) as { token: string };
  context.db.libraryEntry = {
    entry_seq: 1,
    drop_id: "FreshRoot123",
    account_id: account.accountId,
    visibility: "private",
    created_at: Date.now(),
    updated_at: Date.now(),
    deleted_at: null,
  };
  return { ...context, token };
};

describe("isolated staging API composition", () => {
  beforeEach(() => {
    jest.spyOn(console, "info").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());
  test("issues a normal signed session from a proof, pins identity, and preserves normal token authorization", async () => {
    const { request, db, bucket, bindings, pending } = setup();
    const body = await proof();
    const response = await request("/api/auth/session", jsonPost(body));
    expect(response.status).toBe(200);
    const issued = (await response.json()) as {
      token: string;
      accountId: string;
    };
    expect(
      await verifyAccountSessionToken(issued.token, bindings),
    ).toMatchObject({ accountId: body.accountId });
    expect(db.accounts.get(body.accountId)?.signing_public_jwk).toBe(
      JSON.stringify(body.signingPublicJwk),
    );
    expect(
      await bucket.get(`${ACCOUNT_RECORD_PREFIX}${body.accountId}.json`),
    ).not.toBeNull();
    expect(response.headers.get("x-request-id")).toBeTruthy();
    expect(
      jest
        .mocked(console.info)
        .mock.calls.map(([value]) => JSON.parse(String(value))),
    ).toContainEqual(
      expect.objectContaining({
        event: "http.complete",
        surface: "auth",
        status: 200,
        reason: "completed",
        environment: "staging",
        durationMs: expect.any(Number),
        requestId: response.headers.get("x-request-id"),
      }),
    );
    const authorized = await request("/api/delete/FreshRoot123", {
      method: "DELETE",
      headers: { authorization: `Bearer ${issued.token}` },
    });
    expect(authorized.status).toBe(501);
    expect(await authorized.json()).toMatchObject({
      code: "capability_unsupported",
    });
    const invalid = await request("/api/delete/FreshRoot123", {
      method: "DELETE",
      headers: { authorization: `Bearer ${issued.token}invalid` },
    });
    expect(invalid.status).toBe(401);
    await Promise.all(pending);
  });

  test("rejects invalid and expired signed proofs without creating accounts", async () => {
    const { request, db, bucket } = setup();
    const bad = await proof();
    bad.accountId = "changed-after-signing";
    const expired = await proof(
      "expired-proof-account",
      Date.now() - 6 * 60 * 1000,
    );
    for (const body of [bad, expired]) {
      const response = await request("/api/auth/session", jsonPost(body));
      expect(response.status).toBe(401);
      expect(
        jest
          .mocked(console.info)
          .mock.calls.map(([value]) => JSON.parse(String(value))),
      ).toContainEqual(
        expect.objectContaining({
          event: "http.complete",
          surface: "auth",
          status: 401,
          reason: "account_proof_rejected",
          requestId: response.headers.get("x-request-id"),
        }),
      );
      expect(
        await bucket.get(`${ACCOUNT_RECORD_PREFIX}${body.accountId}.json`),
      ).toBeNull();
    }
    expect(db.accounts.size).toBe(0);
    const logs = JSON.stringify(jest.mocked(console.info).mock.calls);
    expect(logs).not.toContain(bad.signature);
    expect(logs).not.toContain(expired.accountId);
  });

  test("rejects a different signing key after the account's first normal session", async () => {
    const { request, db } = setup();
    const original = await proof();
    expect(
      (await request("/api/auth/session", jsonPost(original))).status,
    ).toBe(200);
    expect(
      (
        await request(
          "/api/auth/session",
          jsonPost(await proof(original.accountId)),
        )
      ).status,
    ).toBe(401);
    expect(db.accounts.get(original.accountId)?.signing_public_jwk).toBe(
      JSON.stringify(original.signingPublicJwk),
    );
  });

  test.each(["production", "", "local-test"])(
    "fails closed outside staging: %s",
    async (environment) => {
      const { request, bindings, db } = setup();
      bindings.ENVIRONMENT = environment;
      const response = await request(
        "/api/auth/session",
        jsonPost(await proof()),
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("x-diagnostic-reason")).toBe(
        "staging_configuration_unavailable",
      );
      expect(db.sqlLog).toEqual([]);
    },
  );

  test.each([
    "STATE_PLANE",
    "DB",
    "R2_BUCKET",
    "ACCOUNT_AUTH_SECRET",
    "PROVIDER_ENCRYPTION_PRIVATE_JWK",
    "PROVIDER_SIGNING_PRIVATE_JWK",
  ] as const)("fails closed with missing %s", async (key) => {
    const { request, bindings, db } = setup();
    Reflect.deleteProperty(bindings, key);
    expect(
      (await request("/api/store", jsonPost({ content: "must not store" })))
        .status,
    ).toBe(503);
    expect(db.sqlLog).toEqual([]);
  });

  test.each([undefined, {}])(
    "default gateway instruments missing or malformed service binding (%s)",
    async (serviceBinding) => {
      const { bindings, pending, execution } = setup();
      const operationId = crypto.randomUUID();
      const requestId = crypto.randomUUID();
      const response = await Reflect.apply(stagingApi.fetch, stagingApi, [
        new Request("https://staging.example/api/auth/session", {
          headers: {
            "x-operation-id": operationId,
            "x-request-id": requestId,
          },
        }),
        { ...bindings, STATE_PLANE: serviceBinding },
        execution,
      ]);
      await Promise.all(pending);
      expect(response.status).toBe(503);
      expect(response.headers.get("x-request-id")).toBeTruthy();
      expect(response.headers.get("x-operation-id")).toBe(operationId);
      expect(
        jest
          .mocked(console.info)
          .mock.calls.map(([value]) => JSON.parse(String(value))),
      ).toContainEqual(
        expect.objectContaining({
          event: "http.complete",
          environment: "staging",
          requestId: response.headers.get("x-request-id"),
          operationId,
          status: 503,
          reason: "staging_configuration_unavailable",
        }),
      );
    },
  );

  test("ignores account-header authority even if a binding tries to enable it", async () => {
    const { request, bindings } = setup();
    Object.assign(bindings, { ALLOW_INSECURE_ACCOUNT_HEADER: "1" });
    const response = await request("/api/branches/resolve/FreshRoot123", {
      method: "POST",
      headers: { "x-nulldown-account-id": "trusted-looking-account" },
    });
    expect(response.status).toBe(401);
    expect(bindings).not.toHaveProperty("localBranchApplication");
  });

  test("retains real method and unsupported-root-mutation responses; malformed paths fail before storage", async () => {
    const { request, db } = setup();
    expect((await request("/api/auth/session")).status).toBe(405);
    expect((await request("/api/fixture/control")).status).toBe(404);
    expect((await request("/api/get/%ZZ")).status).toBe(400);
    const mutation = await request("/api/store", jsonPost({ upsert: true }));
    expect(mutation.status).toBe(501);
    expect(await mutation.json()).toMatchObject({
      code: "capability_unsupported",
    });
    expect(db.sqlLog).toEqual([]);
  });

  test("creates request-owned adapters and maps service transport failure without legacy fallback", async () => {
    const { bindings, db } = setup();
    bindings.STATE_PLANE.readPlacement = jest.fn(async () => {
      throw Error("private service down");
    });
    const first = createStagingBranchApplication(bindings);
    const second = createStagingBranchApplication(bindings);
    expect(first).not.toBe(second);
    expect(first.commits).not.toBe(second.commits);
    expect(first.lifecycle).not.toBe(second.lifecycle);
    expect(first).toMatchObject({ mode: "hosted-staging" });
    expect(first.data).toBeUndefined();
    expect(first.snapshotters).toBeUndefined();
    await expect(
      first.lifecycle!.requireActivePlacement({
        rootDropId: "FreshRoot123",
        branchId: "owner",
      }),
    ).rejects.toEqual(new BranchStateError("state_unavailable"));
    expect(db.sqlLog).toEqual([]);
  });

  test("instruments the selected RPC on a real route with request correlation", async () => {
    const { request, bindings, token } = await authenticatedResolve();
    bindings.STATE_PLANE.readPlacement = jest.fn(async () => ({
      ok: false as const,
      error: new BranchStateError("branch_not_found").toRecord(),
    }));
    const operationId = crypto.randomUUID();
    const response = await request("/api/branches/resolve/FreshRoot123", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "x-operation-id": operationId,
      },
    });
    expect(response.status).toBe(404);
    const rpcEvents = jest
      .mocked(console.info)
      .mock.calls.map(([value]) => JSON.parse(String(value)));
    const rpcEvent = rpcEvents.find(
      (event) => event.event === "state_plane.rpc",
    );
    expect(rpcEvent).toEqual(
      expect.objectContaining({
        environment: "staging",
        version: 1,
        requestId: response.headers.get("x-request-id"),
        operationId,
        method: "readPlacement",
        outcome: "failure",
        reason: "branch_not_found",
        durationMs: expect.any(Number),
      }),
    );
    expect(rpcEvents).toContainEqual(
      expect.objectContaining({
        event: "http.complete",
        environment: "staging",
        requestId: response.headers.get("x-request-id"),
        operationId,
        reason: "not_found",
      }),
    );
  });

  test("records successful RPC results and isolates a throwing log sink", async () => {
    const { request, bindings, token } = await authenticatedResolve();
    bindings.STATE_PLANE.readPlacement = jest.fn(async () => ({
      ok: true as const,
      value: null,
    }));
    const rpcEvents: unknown[] = [];
    jest.spyOn(console, "info").mockImplementation((value) => {
      const event = JSON.parse(String(value)) as { event?: string };
      if (event.event === "state_plane.rpc") rpcEvents.push(event);
      throw Error("log sink failure");
    });
    const response = await request("/api/branches/resolve/FreshRoot123", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(503);
    expect(rpcEvents).toContainEqual(
      expect.objectContaining({
        environment: "staging",
        method: "readPlacement",
        outcome: "success",
        reason: "completed",
      }),
    );
  });

  test("bounds thrown dependency reasons and never logs exception details", async () => {
    const { request, bindings, token } = await authenticatedResolve();
    bindings.STATE_PLANE.readPlacement = jest.fn(async () => {
      throw Object.assign(Error("private dependency detail"), {
        code: "untrusted-secret-and-input",
      });
    });
    const response = await request("/api/branches/resolve/FreshRoot123", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(503);
    const events = jest
      .mocked(console.info)
      .mock.calls.map(([value]) => JSON.parse(String(value)));
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "state_plane.rpc",
        outcome: "failure",
        reason: "state_unavailable",
      }),
    );
    const output = JSON.stringify(events);
    expect(output).not.toContain("private dependency detail");
    expect(output).not.toContain("untrusted-secret-and-input");
  });

  test("preserves request correlation and response outcomes when telemetry fails", async () => {
    const { request, pending } = setup();
    const events: unknown[] = [];
    jest.spyOn(console, "info").mockImplementation((value) => {
      events.push(JSON.parse(String(value)));
      throw Error("telemetry down");
    });
    const operation = crypto.randomUUID();
    const response = await request("/api/auth/session", {
      headers: { "x-operation-id": operation },
    });
    expect(response.status).toBe(405);
    expect(response.headers.get("x-operation-id")).toBe(operation);
    await Promise.all(pending);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "http.complete",
        operationId: operation,
        requestId: response.headers.get("x-request-id"),
        status: 405,
        reason: "method_not_allowed",
        outcome: "failure",
      }),
    );
  });
});

import { jest } from "@jest/globals";
import type {
  D1Database,
  IncomingRequestCfProperties,
  R2Bucket,
} from "@cloudflare/workers-types";
import {
  fetchProductionEnrollment,
  type ProductionIngressBindings,
} from "../../../../../../../packages/nulldown-state-plane/src/production-ingress";
import { onRequest } from "../../../../../_middleware";
import { MemoryR2Bucket } from "../../../../drops/testing/storage-fixture";
import { MemoryD1Database } from "../../../d1/testing/metadata-fixture";

const root = "1rIbFszcNmrt";
const target = { rootDropId: root, branchId: "owner" };
const request = (path: string, body?: unknown) =>
  new Request<unknown, IncomingRequestCfProperties>(
    `https://production.example${path}`,
    {
      cf: undefined,
      ...(body === undefined
        ? {}
        : { method: "POST", body: JSON.stringify(body) }),
    },
  );
const execution = { waitUntil: () => {} };

describe("production enrollment ingress", () => {
  it.each([
    `/api/diff/${root}`,
    "/api/diff/1rIbFs",
    `/api/%64iff/${root}`,
    `/api/diff/%31rIbFszcNmrt`,
    `/api//diff/${root}/`,
    `/api/branches/${root}/owner/content`,
    `/api/branches/resolve/${root}`,
    `/api/diff-auth/register/${root}`,
    `/api/delete/${root}`,
    `/api/unlock/${root}`,
  ])("fails closed without the authority binding at %s", async (path) => {
    const response = await fetchProductionEnrollment(
      request(path),
      { STATE_PLANE_CANARY_ROOT: root },
      execution,
    );
    expect(response?.status).toBe(503);
    expect(await response?.json()).toMatchObject({ code: "state_unavailable" });
  });

  it.each([
    `/api/diff/%2531rIbFszcNmrt`,
    `/api%2Fdiff/${root}`,
    `/api/diff/%ZZ`,
  ])("rejects ambiguous route decoding at %s", async (path) => {
    expect(
      (
        await fetchProductionEnrollment(
          request(path),
          { STATE_PLANE_CANARY_ROOT: root },
          execution,
        )
      )?.status,
    ).toBe(400);
  });

  it("passes unrelated routes and deployments through", async () => {
    expect(
      await fetchProductionEnrollment(
        request(`/api/diff/${root}`),
        {},
        execution,
      ),
    ).toBeNull();
    expect(
      await fetchProductionEnrollment(
        request("/api/diff/OtherRoot123"),
        { STATE_PLANE_CANARY_ROOT: root },
        execution,
      ),
    ).toBeNull();
  });

  it.each(["metadata", "index"])(
    "contains global %s backfill, including encoded routes",
    async (kind) => {
      expect(
        (
          await fetchProductionEnrollment(
            request(`/api/${kind}/%62ackfill/`),
            { STATE_PLANE_CANARY_ROOT: root },
            execution,
          )
        )?.status,
      ).toBe(501);
    },
  );

  it.each(["state", "submit"])(
    "selects the actual Nullplug %s source, not data values",
    async (kind) => {
      const env = { STATE_PLANE_CANARY_ROOT: root };
      expect(
        (
          await fetchProductionEnrollment(
            request(`/api/nullplug/${kind}`, {
              source: { rootDropId: "1rIbFs" },
            }),
            env,
            execution,
          )
        )?.status,
      ).toBe(503);
      const unrelated = request(`/api/nullplug/${kind}`, {
        source: { rootDropId: "OtherRoot123" },
        value: root,
      });
      expect(
        await fetchProductionEnrollment(unrelated, env, execution),
      ).toBeNull();
      expect(await unrelated.json()).toMatchObject({ value: root });
    },
  );

  it("rejects enrolled Nullplug invocation and bounds chunked bodies without a length header", async () => {
    const env = { STATE_PLANE_CANARY_ROOT: root };
    expect(
      (
        await fetchProductionEnrollment(
          request("/api/nullplug/resolve", {
            call: { caller: { dropId: root } },
          }),
          env,
          execution,
        )
      )?.status,
    ).toBe(501);
    const oversized = request("/api/nullplug/state", {
      value: "x".repeat(512_000),
    });
    expect(oversized.headers.has("content-length")).toBe(false);
    expect(
      (await fetchProductionEnrollment(oversized, env, execution))?.status,
    ).toBe(413);
  });

  it("retains the outer request identity and never falls back after authority failure", async () => {
    const pending: Promise<unknown>[] = [];
    const next = jest.fn(async () => new Response("legacy fallback"));
    const telemetry: unknown[] = [];
    const unavailable = async (): Promise<never> => {
      throw Error("unavailable");
    };
    const readAuthority = jest.fn(async () => ({
      ok: true as const,
      value: {
        target,
        backend: "legacy" as const,
        placement: { routingVersion: 1 as const, generation: 0 },
        sourcePhase: "legacy" as const,
        migrationId: null,
      },
    }));
    const env: ProductionIngressBindings = {
      STATE_PLANE_CANARY_ROOT: root,
      R2_BUCKET: new MemoryR2Bucket() as unknown as R2Bucket,
      DB: new MemoryD1Database() as unknown as D1Database,
      ACCOUNT_AUTH_SECRET: "test-only",
      PROVIDER_ENCRYPTION_PRIVATE_JWK: "configured",
      PROVIDER_SIGNING_PRIVATE_JWK: "configured",
      STATE_PLANE: {
        readAuthority,
        admitSourceWriter: unavailable,
        completeSourceWriter: unavailable,
        append: unavailable,
        readHead: unavailable,
        readContent: unavailable,
        readEvents: unavailable,
      },
    };
    const context = {
      request: request(`/api/branches/${root}/owner/content`, {}),
      params: {},
      data: {},
      functionPath: "/api",
      next,
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise);
      },
      passThroughOnException() {
        throw Error("unexpected fallback");
      },
      env: {
        ...env,
        ASSETS: { fetch },
        TELEMETRY: {
          async fetch(input: Request) {
            telemetry.push(await input.json());
            return new Response(null, { status: 204 });
          },
        },
      },
    };
    const response = await onRequest(context);
    await Promise.all(pending);
    expect(response.status).toBe(405);
    expect(next).not.toHaveBeenCalled();
    expect(JSON.stringify(telemetry)).toContain(
      response.headers.get("x-request-id"),
    );
    readAuthority.mockImplementation(unavailable);
    const failed = await onRequest({
      ...context,
      request: request(`/api/diff/${root}`),
    });
    await Promise.all(pending);
    expect(failed.status).toBe(503);
    expect(next).not.toHaveBeenCalled();
  });
});

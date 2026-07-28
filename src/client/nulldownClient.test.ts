import { createHmac } from "node:crypto";
import {
  DIFF_CLIENT_ID_HEADER,
  DIFF_SECRET_KID_HEADER,
  DIFF_SIGNATURE_HEADER,
  DIFF_SIGNATURE_PREFIX,
  DIFF_TIMESTAMP_HEADER,
  buildDiffSigningPayload,
} from "../../shared/drop/diffAuth";
import { createNulldownClient } from "./nulldownClient";
import { NULLPLUG_INVOKE_CONTENT_TYPE } from "../../shared/nullplug/registry";

const base64UrlEncode = (value: string): string =>
  Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

describe("NulldownClient", () => {
  it("signs diff_apply requests with exported diff auth tokens", async () => {
    const token = `ndauth.v1.${base64UrlEncode(
      JSON.stringify({
        version: 1,
        kind: "nulldown.diff-auth.v1",
        createdAt: 1,
        keys: null,
        credentials: {
          "drop-canonical": {
            version: 1,
            dropId: "drop-canonical",
            branchId: "branch-1",
            baseUrl: "https://nulldown.test",
            clientId: "client-1",
            kid: "kid-1",
            secret: "secret-1",
            createdAt: 1,
            expiresAt: null,
          },
        },
      }),
    )}`;
    const captured: { url?: string; init?: RequestInit } = {};
    const client = createNulldownClient({
      baseUrl: "https://nulldown.test",
      diffAuthToken: token,
      fetch: async (url, init) => {
        captured.url = String(url);
        captured.init = init;
        return Response.json({ accepted: 1 });
      },
    });

    await client.applyDiff({
      dropId: "route-drop",
      branchId: "branch-1",
      eventDropId: "drop-canonical",
      ops: [{ type: "insert", start: 0, end: 0, text: "hello" }],
    });

    const headers = new Headers(captured.init?.headers);
    const timestamp = headers.get(DIFF_TIMESTAMP_HEADER) ?? "";
    const body = String(captured.init?.body ?? "");
    const expectedSignature = `${DIFF_SIGNATURE_PREFIX}${createHmac(
      "sha256",
      "secret-1",
    )
      .update(
        buildDiffSigningPayload(
          "POST",
          "/api/diff/route-drop",
          timestamp,
          body,
        ),
      )
      .digest("hex")}`;

    expect(captured.url).toBe(
      "https://nulldown.test/api/diff/route-drop?branchId=branch-1",
    );
    expect(headers.get(DIFF_CLIENT_ID_HEADER)).toBe("client-1");
    expect(headers.get(DIFF_SECRET_KID_HEADER)).toBe("kid-1");
    expect(headers.get(DIFF_SIGNATURE_HEADER)).toBe(expectedSignature);
    expect(JSON.parse(body)).toEqual(
      expect.objectContaining({
        version: 1,
        events: [
          expect.objectContaining({
            dropId: "drop-canonical",
            sourceClientId: "nulldown-mcp",
          }),
        ],
      }),
    );
  });

  it("calls typed nullplug provider runtime routes", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = createNulldownClient({
      baseUrl: "https://nulldown.test",
      accountId: "acct-1",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        const requestUrl = String(url);
        if (requestUrl.endsWith("/api/nullplug/resolve")) {
          return Response.json({ result: { content: "resolved" } });
        }
        if (requestUrl.endsWith("/api/nullplug/submit")) {
          return Response.json({
            stored: true,
            indexed: true,
            key: "response-key",
            fact: {},
          });
        }
        if (requestUrl.endsWith("/api/nullplug/state")) {
          return Response.json({ stored: true, key: "state-key", fact: {} });
        }
        if (
          requestUrl.endsWith("/api/nullplug/registry") &&
          init?.method === "POST"
        ) {
          return Response.json({ registered: true, record: {} });
        }
        if (requestUrl.endsWith("/api/nullplug/registry")) {
          return Response.json({ items: [], cursor: null });
        }
        return Response.json({});
      },
    });

    await client.resolveNullplug({
      call: {
        pluginId: "nd",
        args: { id: "drop-1" },
        caller: { dropId: "root-1", branchId: "branch-1" },
      },
      context: {
        providerId: "remote",
        baseUrl: "https://nulldown.test",
        capabilities: ["render"],
      },
    });
    await client.submitNullplugResponse({
      version: 1,
      kind: "ui.response",
      id: "response-1",
      primitiveId: "approve",
      createdAt: 1,
      source: { rootDropId: "root-1", branchId: "branch-1" },
      data: { accepted: true },
    });
    await client.storeNullplugState({
      version: 1,
      kind: "ui.state.patch",
      id: "patch-1",
      callId: "call-1",
      createdAt: 2,
      source: { rootDropId: "root-1", branchId: "branch-1", callId: "call-1" },
      patch: [{ op: "set", path: ["accepted"], value: true }],
    });
    await client.listNullplugRegistry();
    await client.registerNullplugManifest({
      id: "remote.summary",
      version: "1.0.0",
      endpoint: "https://plugins.nulldown.test/summary",
      contentType: NULLPLUG_INVOKE_CONTENT_TYPE,
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      permissions: [{ kind: "drop.read", scope: "caller" }],
    });

    expect(calls.map((call) => call.url)).toEqual([
      "https://nulldown.test/api/nullplug/resolve",
      "https://nulldown.test/api/nullplug/submit",
      "https://nulldown.test/api/nullplug/state",
      "https://nulldown.test/api/nullplug/registry",
      "https://nulldown.test/api/nullplug/registry",
    ]);
    calls.forEach((call) => {
      const headers = new Headers(call.init?.headers);
      expect(headers.get("x-nulldown-account-id")).toBe("acct-1");
    });
    expect(calls.map((call) => call.init?.method ?? "GET")).toEqual([
      "POST",
      "POST",
      "POST",
      "GET",
      "POST",
    ]);
  });

  it("serializes compact procedure step memory query params", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = createNulldownClient({
      baseUrl: "https://nulldown.test",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return Response.json({ capsules: [], records: [], procedureSteps: [] });
      },
    });

    await client.queryMemory({
      rootId: "root-1",
      branchId: "branch:1",
      procedureId: "memproc:1",
      afterStep: 0,
      stepLimit: 1,
      includeRecords: false,
    });

    expect(calls[0]?.url).toBe(
      "https://nulldown.test/api/branches/root-1/branch:1/memory/query?procedureId=memproc%3A1&afterStep=0&stepLimit=1&includeRecords=false",
    );
  });
});

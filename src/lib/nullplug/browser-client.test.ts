import type { NullplugInvokeRequest } from "../../../shared/nullplug/types";
import type {
  NullplugUiResponseFact,
  NullplugUiStatePatchFact,
} from "../../../shared/nullplug/ui";
import type { NullplugRuntime } from "../../../shared/nullplug/runtime";
import { createBrowserNullplugClient } from "./browser-client";

const invokeRequest: NullplugInvokeRequest = {
  call: {
    pluginId: "test.plugin",
    args: {},
    caller: {},
  },
  context: {
    providerId: "browser",
    baseUrl: "https://nulldown.test",
    capabilities: [],
  },
};

describe("browser nullplug client", () => {
  it("delegates invocation and support checks to the injected runtime", async () => {
    const calls: string[] = [];
    const runtime: NullplugRuntime = {
      async supports(request) {
        calls.push(`supports:${request.call.pluginId}`);
        return true;
      },
      async invoke(request) {
        calls.push(`invoke:${request.call.pluginId}`);
        return { result: { content: "delegated" } };
      },
    };
    const client = createBrowserNullplugClient({
      nullplugRuntime: runtime,
      fetchImpl: async () => Response.json({}),
      authTokenProvider: null,
    });

    await expect(client.supports!(invokeRequest)).resolves.toBe(true);
    await expect(client.invoke(invokeRequest)).resolves.toEqual({
      result: { content: "delegated" },
    });
    expect(calls).toEqual(["supports:test.plugin", "invoke:test.plugin"]);
  });

  it("submits response and state facts through the branch API transport", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    let authCalls = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), init });
      return Response.json({ stored: true, indexed: true, key: "fact-key" });
    };
    const client = createBrowserNullplugClient({
      nullplugRuntime: {
        async invoke() {
          return { result: {} };
        },
      },
      baseUrl: "https://nulldown.test/",
      fetchImpl,
      authTokenProvider: async () => {
        authCalls += 1;
        return "session-token";
      },
    });
    const context = {
      rootDropId: "root-1",
      branchId: "branch-1",
      accountId: "account-1",
      clientId: "client-1",
    };
    const responseFact: NullplugUiResponseFact = {
      version: 1,
      kind: "ui.response",
      id: "response-1",
      primitiveId: "approval-1",
      createdAt: 1,
      source: { rootDropId: "root-1", branchId: "branch-1" },
      data: { approved: true },
    };
    const stateFact: NullplugUiStatePatchFact = {
      version: 1,
      kind: "ui.state.patch",
      id: "state-1",
      callId: "call-1",
      createdAt: 2,
      source: { rootDropId: "root-1", branchId: "branch-1" },
      patch: [{ op: "set", path: ["open"], value: true }],
    };

    await expect(
      client.submitResponse(context, responseFact),
    ).resolves.toBeUndefined();
    await expect(client.submitState(context, stateFact)).resolves.toBeUndefined();

    expect(authCalls).toBe(2);
    expect(requests.map(({ url }) => url)).toEqual([
      "https://nulldown.test/api/nullplug/submit",
      "https://nulldown.test/api/nullplug/state",
    ]);
    for (const request of requests) {
      expect(request.init?.method).toBe("POST");
      const headers = new Headers(request.init?.headers);
      expect(headers.get("content-type")).toBe("application/json");
      expect(headers.get("x-nulldown-account-id")).toBe("account-1");
      expect(headers.get("x-nulldown-client-id")).toBe("client-1");
      expect(headers.get("authorization")).toBe("Bearer session-token");
    }
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual(responseFact);
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual(stateFact);
  });
});

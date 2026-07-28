import { NULLPLUG_INVOKE_CONTENT_TYPE } from "../../../shared/nullplug/registry";
import { createRemoteNullplugRuntime } from "./providerRuntime";

const invokeRequest = {
  call: {
    pluginId: "remote.summary",
    args: { topic: "runtime" },
    caller: {},
  },
  context: {
    providerId: "browser",
    baseUrl: "https://nulldown.test",
    capabilities: ["render"],
  },
};

describe("browser remote nullplug runtime", () => {
  it("discovers registered plugins and invokes the provider runtime", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/api/nullplug/registry")) {
        return new Response(
          JSON.stringify({
            items: [
              {
                id: "remote.summary",
                version: "1.0.0",
                endpoint: "https://plugins.nulldown.test/summary",
                contentType: NULLPLUG_INVOKE_CONTENT_TYPE,
                inputSchema: { type: "object" },
                outputSchema: { type: "object" },
                permissions: [],
              },
            ],
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      const body = JSON.parse(String(init?.body)) as {
        call: { version?: string };
      };
      expect(body.call.version).toBe("1.0.0");
      return new Response(
        JSON.stringify({
          result: { content: "Remote summary" },
          resolution: {
            pluginId: "spoofed",
            providerId: "plugin-output",
            baseUrl: "https://spoofed.test",
            scope: "remote",
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    };
    const runtime = createRemoteNullplugRuntime({
      providerId: "provider-1",
      baseUrl: "https://nulldown.test",
      fetchImpl,
    });

    expect(runtime.supports).toBeDefined();
    await expect(runtime.supports!(invokeRequest)).resolves.toBe(true);
    await expect(runtime.invoke(invokeRequest)).resolves.toEqual({
      result: { content: "Remote summary" },
      resolution: {
        pluginId: "remote.summary",
        version: "1.0.0",
        providerId: "provider-1",
        baseUrl: "https://nulldown.test",
        scope: "remote",
      },
    });
    expect(calls).toEqual([
      "https://nulldown.test/api/nullplug/registry",
      "https://nulldown.test/api/nullplug/resolve",
    ]);
  });

  it("does not invoke unregistered plugin ids", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ items: [] }), {
        headers: { "Content-Type": "application/json" },
      });
    const runtime = createRemoteNullplugRuntime({ fetchImpl });

    expect(runtime.supports).toBeDefined();
    await expect(runtime.supports!(invokeRequest)).resolves.toBe(false);
    await expect(runtime.invoke(invokeRequest)).rejects.toMatchObject({
      code: "unsupported_plugin",
    });
    await expect(runtime.invoke(invokeRequest)).rejects.toHaveProperty(
      "resolution",
      undefined,
    );
  });

  it("discovers plugin ownership across registry pages", async () => {
    const calls: string[] = [];
    const runtime = createRemoteNullplugRuntime({
      baseUrl: "https://nulldown.test",
      fetchImpl: async (input) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith("?cursor=next-page")) {
          return new Response(
            JSON.stringify({
              items: [
                {
                  id: "remote.summary",
                  version: "1.0.0",
                  endpoint: "https://plugins.nulldown.test/summary",
                  contentType: NULLPLUG_INVOKE_CONTENT_TYPE,
                  inputSchema: { type: "object" },
                  outputSchema: { type: "object" },
                  permissions: [],
                },
              ],
              cursor: null,
            }),
            { headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ items: [], cursor: "next-page" }), {
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    await expect(runtime.supports!(invokeRequest)).resolves.toBe(true);
    expect(calls).toEqual([
      "https://nulldown.test/api/nullplug/registry",
      "https://nulldown.test/api/nullplug/registry?cursor=next-page",
    ]);
  });

  it("preserves structured provider policy failures and resolution", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input).endsWith("/api/nullplug/registry")) {
        return new Response(
          JSON.stringify({
            items: [
              {
                id: "remote.summary",
                version: "1.0.0",
                endpoint: "https://plugins.nulldown.test/summary",
                contentType: NULLPLUG_INVOKE_CONTENT_TYPE,
                inputSchema: { type: "object" },
                outputSchema: { type: "object" },
                permissions: [],
              },
            ],
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ code: "policy_denied", error: "Denied by root policy." }),
        {
          status: 403,
          headers: { "Content-Type": "application/json" },
        },
      );
    };
    const runtime = createRemoteNullplugRuntime({
      providerId: "provider-1",
      baseUrl: "https://nulldown.test",
      fetchImpl,
    });

    await expect(runtime.invoke(invokeRequest)).rejects.toMatchObject({
      code: "policy_denied",
      message: "Denied by root policy.",
      resolution: {
        pluginId: "remote.summary",
        version: "1.0.0",
        providerId: "provider-1",
        scope: "remote",
      },
    });
  });

  it("retains selected manifest identity for transport and JSON failures", async () => {
    const registryResponse = () =>
      new Response(
        JSON.stringify({
          items: [
            {
              id: "remote.summary",
              version: "1.0.0",
              endpoint: "https://plugins.nulldown.test/summary",
              contentType: NULLPLUG_INVOKE_CONTENT_TYPE,
              inputSchema: { type: "object" },
              outputSchema: { type: "object" },
              permissions: [],
            },
          ],
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    let transportCalls = 0;
    const transportRuntime = createRemoteNullplugRuntime({
      fetchImpl: async () => {
        transportCalls += 1;
        if (transportCalls === 1) return registryResponse();
        throw new Error("network down");
      },
    });

    await expect(transportRuntime.invoke(invokeRequest)).rejects.toMatchObject({
      code: "provider_transport_failed",
      resolution: { version: "1.0.0", scope: "remote" },
    });

    let jsonCalls = 0;
    const invalidJsonRuntime = createRemoteNullplugRuntime({
      fetchImpl: async () => {
        jsonCalls += 1;
        return jsonCalls === 1
          ? registryResponse()
          : new Response("not-json", { status: 200 });
      },
    });

    await expect(invalidJsonRuntime.invoke(invokeRequest)).rejects.toMatchObject({
      code: "provider_result_invalid",
      resolution: { version: "1.0.0", scope: "remote" },
    });
  });
});

import { jest } from "@jest/globals";
import {
  createNullplugRuntime,
  NullplugRuntimeError,
  type NullplugRuntimeResolver,
} from "./runtime";
import type { NullplugInvokeRequest } from "./types";

const request: NullplugInvokeRequest = {
  call: {
    pluginId: "summary",
    args: { concise: true },
    caller: { dropId: "root-1" },
  },
  context: {
    providerId: "test-provider",
    baseUrl: "https://nulldown.test",
    capabilities: ["render"],
  },
};

describe("nullplug runtime wrapper", () => {
  it("uses the first matching resolver and normalizes string returns", async () => {
    const skipped: NullplugRuntimeResolver = { resolve: () => null };
    const matched: NullplugRuntimeResolver = {
      resolve: () => () => "rendered",
    };
    const runtime = createNullplugRuntime({ resolvers: [skipped, matched] });

    await expect(runtime.supports?.(request)).resolves.toBe(true);
    await expect(runtime.invoke(request)).resolves.toEqual({
      result: { content: "rendered" },
    });
  });

  it("prepares before resolution and validates after normalization", async () => {
    const resolve = jest.fn(() => () => ({ content: "unsafe" }));
    const runtime = createNullplugRuntime({
      resolvers: [{ resolve }],
      policy: {
        prepare: (invokeRequest) => ({
          ...invokeRequest,
          context: { ...invokeRequest.context, capabilities: ["safe"] },
        }),
        validate: (response, invokeRequest) => ({
          result: {},
          diagnostics: [
            {
              level: "warn",
              message: `Denied ${invokeRequest.call.pluginId}: ${response.result.content}`,
            },
          ],
        }),
      },
    });

    await expect(runtime.invoke(request)).resolves.toEqual({
      result: {},
      diagnostics: [{ level: "warn", message: "Denied summary: unsafe" }],
    });
    expect(resolve).toHaveBeenCalledWith(
      expect.objectContaining({ context: expect.objectContaining({ capabilities: ["safe"] }) }),
    );
  });

  it("preserves invoker resolution metadata through policy validation", async () => {
    const runtime = createNullplugRuntime({
      resolvers: [
        {
          resolve: () => ({
            invoke: () => ({
              result: { content: "rendered" },
              resolution: {
                pluginId: "spoofed",
                providerId: "plugin-output",
                baseUrl: "https://spoofed.test",
                scope: "remote" as const,
              },
            }),
            resolution: {
              pluginId: "summary",
              version: "2.0.0",
              providerId: "remote-provider",
              baseUrl: "https://provider.test",
              scope: "remote" as const,
            },
          }),
        },
      ],
      policy: {
        prepare: (invokeRequest) => invokeRequest,
        validate: (response) => ({ result: response.result }),
      },
    });

    await expect(runtime.invoke(request)).resolves.toMatchObject({
      resolution: {
        pluginId: "summary",
        version: "2.0.0",
        providerId: "remote-provider",
        scope: "remote",
      },
    });
  });

  it("uses resolver identity for invocation failures", async () => {
    const resolution = {
      pluginId: "summary",
      version: "2.0.0",
      providerId: "remote-provider",
      baseUrl: "https://provider.test",
      scope: "remote" as const,
    };
    const runtime = createNullplugRuntime({
      resolvers: [
        {
          resolve: () => ({
            resolution,
            invoke: () => {
              throw new NullplugRuntimeError("policy_denied", "Denied.", {
                resolution: {
                  ...resolution,
                  providerId: "spoofed-provider",
                  version: "9.9.9",
                },
              });
            },
          }),
        },
      ],
    });

    await expect(runtime.invoke(request)).rejects.toMatchObject({
      code: "policy_denied",
      resolution,
    });
  });

  it("does not resolve a plugin when pre-invocation policy rejects it", async () => {
    const resolve = jest.fn(() => () => ({ content: "unsafe" }));
    const runtime = createNullplugRuntime({
      resolvers: [{ resolve }],
      policy: {
        prepare: () => {
          throw new NullplugRuntimeError("policy_denied", "Denied by root policy.");
        },
        validate: (response) => response,
      },
    });

    await expect(runtime.invoke(request)).rejects.toMatchObject({
      code: "policy_denied",
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("rejects unsupported plugins and invalid invoker returns", async () => {
    const unsupported = createNullplugRuntime({ resolvers: [] });
    await expect(unsupported.supports?.(request)).resolves.toBe(false);
    await expect(unsupported.invoke(request)).rejects.toMatchObject({
      code: "unsupported_plugin",
    });

    const invalid = createNullplugRuntime({
      resolvers: [
        {
          resolve: () => () =>
            ({ result: { content: 42 } }) as unknown as string,
        },
      ],
    });
    await expect(invalid.invoke(request)).rejects.toEqual(
      expect.objectContaining<Partial<NullplugRuntimeError>>({
        code: "invalid_result",
      }),
    );
  });
});

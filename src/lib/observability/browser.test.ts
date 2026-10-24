import { jest } from "@jest/globals";
import { installBrowserTelemetry, reportBrowserEvent } from "./browser";

it("correlates same-origin API traffic and sends safe bounded reports without reading responses", async () => {
  jest.useFakeTimers();
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalLocation = Object.getOwnPropertyDescriptor(
    globalThis,
    "location",
  );
  const calls: Array<{ input: unknown; init?: RequestInit }> = [];
  const transport: typeof fetch = async (input, init) => {
    calls.push({ input, init });
    return new Response("unchanged", {
      headers: { "x-request-id": "637f7584-1781-411f-ab2f-051776f1aac0" },
    });
  };
  const browser = { fetch: transport, addEventListener: () => undefined };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: browser,
  });
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { href: "https://nulldown.app/", origin: "https://nulldown.app" },
  });
  try {
    installBrowserTelemetry();
    const response = await browser.fetch(
      "/api/get/private-document?token=secret",
    );
    expect(await response.text()).toBe("unchanged");
    const operationId = new Headers(calls[0].init?.headers).get(
      "x-operation-id",
    );
    expect(operationId).toMatch(/^[a-f0-9-]{36}$/);
    await browser.fetch("https://external.test/resource");
    expect(calls[1].init).toBeUndefined();
    reportBrowserEvent("draft.created", "success");
    await jest.advanceTimersByTimeAsync(1000);
    const delivery = calls.find((call) => call.input === "/api/telemetry");
    expect(delivery).toBeDefined();
    const body = String(delivery?.init?.body);
    expect(body).not.toContain("secret");
    expect(body).not.toContain("private-document");
    expect(JSON.parse(body)).toEqual([
      expect.objectContaining({
        event: "http.complete",
        operationId,
        surface: "get",
      }),
      expect.objectContaining({ event: "draft.created", operationId }),
    ]);
  } finally {
    if (originalWindow)
      Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (originalLocation)
      Object.defineProperty(globalThis, "location", originalLocation);
    else Reflect.deleteProperty(globalThis, "location");
    jest.useRealTimers();
  }
});

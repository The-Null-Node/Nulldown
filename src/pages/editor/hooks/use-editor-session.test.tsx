/** @jest-environment jsdom */
import React, { StrictMode } from "react";
import { cleanup, renderHook } from "@testing-library/react";
import { TextEncoder, TextDecoder } from "node:util";
import { webcrypto } from "node:crypto";
import type { NullplugRuntime } from "../../../../shared/nullplug/runtime";

Object.assign(globalThis, { TextEncoder, TextDecoder });
Object.defineProperty(globalThis, "crypto", {
  value: webcrypto,
  configurable: true,
});
const { default: useEditorStore } =
  await import("../../../stores/editor-store");
const { useEditorSession } = await import("./use-editor-session");

afterEach(cleanup);

it("survives StrictMode replay and fences an unmounted route", () => {
  const runtime = {} as NullplugRuntime;
  const route = renderHook(() => useEditorSession(runtime), {
    wrapper: ({ children }) => <StrictMode>{children}</StrictMode>,
  });
  const origin = route.result.current!;
  expect(origin.isActive()).toBe(true);
  route.unmount();
  expect(origin.isActive()).toBe(false);
  expect(() => origin.editor.seedSnapshot("late load")).toThrow("disposed");

  const successor = renderHook(() => useEditorSession(runtime));
  successor.result.current!.editor.seedSnapshot("new route");
  origin.editor.dispose();
  expect(useEditorStore.getState().textContent).toBe("new route");
});

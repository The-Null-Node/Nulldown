/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { jest } from "@jest/globals";
import CliAuthPage from "./CliAuthPage";

const originalFetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");

describe("CliAuthPage", () => {
  afterEach(() => {
    window.history.pushState({}, "", "/");
    if (originalFetchDescriptor) {
      Object.defineProperty(globalThis, "fetch", originalFetchDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, "fetch");
    }
  });

  it("requires sign-in before approving a device code", async () => {
    window.history.pushState({}, "", "/auth/cli?code=ABCD-EFGH-JKLM");
    const fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ authenticated: false }),
    });
    Object.defineProperty(globalThis, "fetch", { value: fetch, configurable: true });

    render(<CliAuthPage />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Sign in" })).not.toBeNull();
    });
    expect(screen.getByText("ABCD-EFGH-JKLM")).not.toBeNull();
  });

  it("submits an approved account after signed-in browser hydration", async () => {
    window.history.pushState({}, "", "/auth/cli?code=ABCD-EFGH-JKLM");
    const fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ userId: "user-1" }),
      })
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ approved: true, accountId: "account-1" }),
      });
    Object.defineProperty(globalThis, "fetch", { value: fetch, configurable: true });

    render(<CliAuthPage />);

    const input = await screen.findByLabelText("Account ID");
    fireEvent.change(input, { target: { value: "account-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Authorize CLI" }));

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain(
        "CLI authorized. Return to your terminal.",
      );
    });
    expect(fetch).toHaveBeenLastCalledWith("/api/auth/cli/approve", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userCode: "ABCD-EFGH-JKLM", accountId: "account-1" }),
    });
  });
});

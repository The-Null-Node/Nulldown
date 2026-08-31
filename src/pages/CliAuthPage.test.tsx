/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { jest } from "@jest/globals";
import CliAuthPage from "./CliAuthPage";

const originalFetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");

describe("CliAuthPage", () => {
  afterEach(() => {
    window.history.pushState({}, "", "/");
    jest.restoreAllMocks();
    if (originalFetchDescriptor) {
      Object.defineProperty(globalThis, "fetch", originalFetchDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, "fetch");
    }
  });

  it("requires sign-in before approving a device code", async () => {
    window.history.pushState({}, "", "/auth/cli?code=ABCD-EFGH-JKLM");
    const replaceState = jest.spyOn(window.history, "replaceState");
    const fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ authenticated: false }),
    });
    Object.defineProperty(globalThis, "fetch", { value: fetch, configurable: true });

    render(<CliAuthPage />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Sign in" })).not.toBeNull();
    });
    expect(screen.queryByText("ABCD-EFGH-JKLM")).toBeNull();
    expect(window.location.search).toBe("");
    expect(replaceState).toHaveBeenCalledWith(expect.anything(), "", "/auth/cli");
  });

  it("submits an approved account after signed-in browser hydration", async () => {
    window.history.pushState({}, "", "/auth/cli");
    const fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ userId: "user-1" }),
      })
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ accountId: "account-1", clientName: "test-cli", authoring: null }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ approved: true, accountId: "account-1" }),
      });
    Object.defineProperty(globalThis, "fetch", { value: fetch, configurable: true });

    render(<CliAuthPage />);

    const userCode = await screen.findByLabelText("Authorization code");
    const input = await screen.findByLabelText("Account ID");
    const submit = screen.getByRole("button", { name: "Review CLI" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: "account-1" } });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(userCode, { target: { value: "abcdefghjklm" } });
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    fireEvent.submit(userCode.closest("form") as HTMLFormElement);

    const approve = await screen.findByRole("button", { name: "Authorize CLI" });
    fireEvent.click(approve);

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
      body: JSON.stringify({ userCode: "ABCDEFGHJKLM", accountId: "account-1" }),
    });
  });

  it("keeps a retryable approval error visible until the next submission", async () => {
    window.history.pushState({}, "", "/auth/cli");
    const fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ userId: "user-1" }),
      })
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ accountId: "account-1", clientName: "test-cli", authoring: null }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({ error: "invalid_or_expired_cli_code" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ approved: true, accountId: "account-1" }),
      });
    Object.defineProperty(globalThis, "fetch", { value: fetch, configurable: true });

    render(<CliAuthPage />);

    const userCode = await screen.findByLabelText("Authorization code");
    fireEvent.change(userCode, { target: { value: "ABCD-EFGH-JKLM" } });
    fireEvent.change(screen.getByLabelText("Account ID"), {
      target: { value: "account-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review CLI" }));

    const submit = await screen.findByRole("button", { name: "Authorize CLI" });
    fireEvent.click(submit);

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain(
        "This CLI authorization code is invalid or expired.",
      );
    });
    expect((submit as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(submit);
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain(
        "CLI authorized. Return to your terminal.",
      );
    });
  });
});

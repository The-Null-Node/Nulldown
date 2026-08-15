/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { jest } from "@jest/globals";
import OpenAuthAccountControl from "./OpenAuthAccountControl";

const originalFetchDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "fetch",
);

const installFetch = (fetch: jest.Mock): void => {
  Object.defineProperty(globalThis, "fetch", {
    value: fetch,
    configurable: true,
  });
};

describe("OpenAuthAccountControl", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    if (originalFetchDescriptor) {
      Object.defineProperty(globalThis, "fetch", originalFetchDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, "fetch");
    }
  });

  it("shows loading before resolving a signed-out OpenAuth principal", async () => {
    const fetch = jest.fn().mockResolvedValue({ ok: false });
    installFetch(fetch);

    render(<OpenAuthAccountControl />);

    const loadingButton = screen.getByRole("button", {
      name: "Checking account...",
    });
    expect(loadingButton.hasAttribute("disabled")).toBe(true);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Sign in" })).not.toBeNull();
    });
  });

  it("keeps the signed-in UI until the logout POST succeeds", async () => {
    let completeLogout: ((response: { ok: boolean }) => void) | undefined;
    const fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ userId: "user-1" }),
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            completeLogout = resolve;
          }),
      );
    installFetch(fetch);

    render(<OpenAuthAccountControl />);

    await waitFor(() => {
      expect(screen.getByText("Signed in")).not.toBeNull();
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    const pendingButton = screen.getByRole("button", { name: "Signing out..." });
    expect(pendingButton.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Signed in")).not.toBeNull();
    expect(fetch).toHaveBeenNthCalledWith(2, "/api/auth/open/logout", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
    });

    completeLogout?.({ ok: true });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Sign in" })).not.toBeNull();
    });
  });

  it("keeps the principal visible and shows an error when logout fails", async () => {
    const fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ userId: "user-1" }),
      })
      .mockResolvedValueOnce({ ok: false });
    installFetch(fetch);

    render(<OpenAuthAccountControl />);

    await waitFor(() => {
      expect(screen.getByText("Signed in")).not.toBeNull();
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toBe("Sign out failed");
    });
    expect(screen.getByText("Signed in")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Sign out" })).not.toBeNull();
  });
});

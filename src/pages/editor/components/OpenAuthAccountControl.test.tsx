/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { jest } from "@jest/globals";
import OpenAuthAccountControl from "./OpenAuthAccountControl";
import {
  LOCAL_ACCOUNT_VAULT_CHANGED_EVENT,
  setActiveVaultUser,
} from "@/lib/void/vault/passkeyVault";

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

const localVaultRecord = (accountId: string) => ({
  version: 1,
  accountId,
  encryptionKid: "enc_01",
  signingKid: "sig_01",
  encryptionPublicJwk: { kty: "RSA", n: "n".repeat(342), e: "AQAB" },
  encryptionPrivateJwk: {
    kty: "RSA",
    n: "n".repeat(342),
    e: "AQAB",
    d: "d".repeat(342),
    p: "p".repeat(171),
    q: "q".repeat(171),
    dp: "a".repeat(171),
    dq: "b".repeat(171),
    qi: "c".repeat(171),
  },
  signingPublicJwk: {
    kty: "EC",
    crv: "P-256",
    x: "x".repeat(43),
    y: "y".repeat(43),
  },
  signingPrivateJwk: {
    kty: "EC",
    crv: "P-256",
    x: "x".repeat(43),
    y: "y".repeat(43),
    d: "d".repeat(43),
  },
  createdAt: 1,
  updatedAt: 1,
});

describe("OpenAuthAccountControl", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    setActiveVaultUser(null);
    window.localStorage.clear();
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
      .mockResolvedValueOnce({ ok: false, status: 404 })
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
    expect(fetch).toHaveBeenNthCalledWith(3, "/api/auth/open/logout", {
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
      .mockResolvedValueOnce({ ok: false, status: 404 })
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

  it("offers setup without creating or replacing the current local account", async () => {
    window.localStorage.setItem(
      "nulldown_account_vault_v1",
      JSON.stringify(localVaultRecord("account-1")),
    );
    installFetch(
      jest
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ userId: "user-1" }),
        })
        .mockResolvedValueOnce({ ok: false, status: 404 }),
    );

    render(<OpenAuthAccountControl />);
    const setup = await screen.findByRole("button", { name: "Set up sync" });
    fireEvent.click(setup);

    expect(await screen.findByRole("heading", { name: "Set up sync" })).not.toBeNull();
    expect(screen.getByText(/Encrypt this browser's private-drop keys/)).not.toBeNull();
    expect(screen.getByRole("button", { name: "Create recovery code" })).not.toBeNull();
  });

  it("refreshes sync status when a local account is created after sign-in", async () => {
    const fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ userId: "user-1" }),
      })
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({ ok: false, status: 404 });
    installFetch(fetch);

    render(<OpenAuthAccountControl />);
    await waitFor(() => {
      expect(screen.getByText("Signed in")).not.toBeNull();
    });

    window.localStorage.setItem(
      "nulldown_account_vault_v1",
      JSON.stringify(localVaultRecord("account-1")),
    );
    window.dispatchEvent(new Event(LOCAL_ACCOUNT_VAULT_CHANGED_EVENT));

    expect(
      await screen.findByRole("button", { name: "Set up sync" }),
    ).not.toBeNull();
  });

  it("requires a recovery code before restoring a synced account", async () => {
    const metadata = {
      schema: "nulldown.account-recovery-package.v1",
      version: 1,
      userId: "user-1",
      accountId: "account-1",
      revision: 1,
      encryptionKid: "enc_01",
      signingKid: "sig_01",
      signingKeyFingerprint: `sha256:${"a".repeat(43)}`,
      kdf: "HKDF-SHA-256",
      salt: "b".repeat(22),
      aead: "A256GCM",
      iv: "c".repeat(16),
      ciphertextDigest: `sha256:${"d".repeat(43)}`,
      ciphertextLength: 24,
    };
    installFetch(
      jest
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ userId: "user-1" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            package: { metadata, ciphertext: "e".repeat(32) },
          }),
        }),
    );

    render(<OpenAuthAccountControl />);
    const restore = await screen.findByRole("button", { name: "Sync this browser" });
    fireEvent.click(restore);

    const submit = await screen.findByRole("button", { name: "Restore account" });
    expect(submit.hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Recovery code" }), {
      target: { value: "recovery-code" },
    });
    expect(submit.hasAttribute("disabled")).toBe(false);
  });

  it("requires confirmation before replacing a different local account", async () => {
    window.localStorage.setItem(
      "nulldown_account_vault_v1",
      JSON.stringify(localVaultRecord("local-account")),
    );
    const metadata = {
      schema: "nulldown.account-recovery-package.v1",
      version: 1,
      userId: "user-1",
      accountId: "remote-account",
      revision: 1,
      encryptionKid: "enc_01",
      signingKid: "sig_01",
      signingKeyFingerprint: `sha256:${"a".repeat(43)}`,
      kdf: "HKDF-SHA-256",
      salt: "b".repeat(22),
      aead: "A256GCM",
      iv: "c".repeat(16),
      ciphertextDigest: `sha256:${"d".repeat(43)}`,
      ciphertextLength: 24,
    };
    installFetch(
      jest
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ userId: "user-1" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            package: { metadata, ciphertext: "e".repeat(32) },
          }),
        }),
    );

    render(<OpenAuthAccountControl />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Sync this browser" }),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Recovery code" }), {
      target: { value: "recovery-code" },
    });

    const submit = screen.getByRole("button", { name: "Restore account" });
    expect(submit.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/does not yet provide an account switcher/)).not.toBeNull();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(submit.hasAttribute("disabled")).toBe(false);
  });
});

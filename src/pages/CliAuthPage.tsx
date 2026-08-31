import React, { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  beginOpenAuthLogin,
  getOpenAuthSessionState,
  type OpenAuthPrincipal,
  type OpenAuthSessionState,
} from "@/lib/auth/openAuthClient";
import { getAccountSyncState } from "@/lib/auth/accountSyncClient";
import { signLocalDeviceDelegation } from "@/lib/void/vault/passkeyVault";
import { normalizeCliUserCode } from "../../shared/auth/cliDevice";

interface PreparedAuthoringTicket {
  credentialId: string;
  expiresAt: number;
  delegateSigningPublicJwk: JsonWebKey;
}

interface PreparedCliTicket {
  accountId: string;
  clientName: string | null;
  authoring: PreparedAuthoringTicket | null;
}

const approvalMessage = (error: string): string => {
  switch (error) {
    case "account_not_bound":
      return "Connect this account to the signed-in user before authorizing a CLI.";
    case "invalid_or_expired_cli_code":
      return "This CLI authorization code is invalid or expired. Start nd auth login again.";
    case "cli_code_already_approved":
      return "This CLI authorization code was already approved for another account.";
    case "cli_code_redeemed":
      return "This CLI authorization code has already been used.";
    case "invalid_cli_delegation":
      return "The CLI authoring approval could not be verified. Start nd auth login again.";
    default:
      return "The CLI authorization could not be completed.";
  }
};

/** Browser approval surface for a one-time CLI device authorization code. */
const CliAuthPage: React.FC = () => {
  const [session, setSession] = useState<OpenAuthSessionState | null>(null);
  const [principal, setPrincipal] = useState<OpenAuthPrincipal | null>(null);
  const [userCode, setUserCode] = useState("");
  const [accountId, setAccountId] = useState("");
  const [pending, setPending] = useState(false);
  const [prepared, setPrepared] = useState<PreparedCliTicket | null>(null);
  const [approved, setApproved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("code")) return;
    url.searchParams.delete("code");
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  }, []);

  useEffect(() => {
    let active = true;
    void getOpenAuthSessionState().then(async (nextSession) => {
      if (!active) return;
      setSession(nextSession);
      if (nextSession.status !== "authenticated") return;
      setPrincipal(nextSession.principal);
      try {
        const syncState = await getAccountSyncState(nextSession.principal);
        if (!active || syncState.status === "empty") return;
        setAccountId(syncState.accountId);
      } catch {
        // The account id remains an explicit input when local sync is unavailable.
      }
    });
    return () => {
      active = false;
    };
  }, []);

  const normalizedUserCode = normalizeCliUserCode(userCode);

  const signIn = (): void => {
    const url = new URL(window.location.href);
    url.searchParams.delete("code");
    beginOpenAuthLogin({
      pathname: url.pathname,
      search: url.search,
      hash: url.hash,
      assign: (destination) => window.location.assign(destination),
    });
  };

  const prepare = async (): Promise<void> => {
    if (!principal || !normalizedUserCode || !accountId.trim() || pending) return;
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/cli/prepare", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userCode: normalizedUserCode, accountId: accountId.trim() }),
      });
      const body = (await response.json().catch(() => null)) as
        | (PreparedCliTicket & { error?: unknown })
        | null;
      if (!response.ok) {
        setError(approvalMessage(typeof body?.error === "string" ? body.error : ""));
        return;
      }
      if (body?.accountId !== accountId.trim()) {
        setError("The CLI authorization could not be completed.");
        return;
      }
      setPrepared(body);
    } catch {
      setError("The authorization service is unavailable. Try again.");
    } finally {
      setPending(false);
    }
  };

  const approve = async (): Promise<void> => {
    if (!principal || !prepared || pending) return;
    setPending(true);
    setError(null);
    try {
      const delegation = prepared.authoring
        ? await signLocalDeviceDelegation({
            accountId: prepared.accountId,
            credentialId: prepared.authoring.credentialId,
            delegateSigningPublicJwk: prepared.authoring.delegateSigningPublicJwk,
            expiresAt: prepared.authoring.expiresAt,
          })
        : undefined;
      const response = await fetch("/api/auth/cli/approve", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userCode: normalizedUserCode,
          accountId: prepared.accountId,
          ...(delegation ? { delegation } : {}),
        }),
      });
      const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
      if (!response.ok) {
        setError(approvalMessage(typeof body?.error === "string" ? body.error : ""));
        return;
      }
      setApproved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The CLI authorization could not be completed.");
    } finally {
      setPending(false);
    }
  };

  if (session?.status === "anonymous") {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background p-6 text-foreground">
        <section className="w-full max-w-md space-y-4 rounded-lg border border-border p-6">
          <h1 className="text-xl font-semibold">Authorize CLI</h1>
          <p className="text-sm text-muted">
            Sign in to approve CLI access. You will enter the authorization code from your terminal after signing in.
          </p>
          <Button type="button" onClick={signIn}>
            Sign in
          </Button>
        </section>
      </main>
    );
  }

  if (session === null) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background p-6 text-sm text-muted">
        Checking sign-in...
      </main>
    );
  }

  if (session.status === "unavailable" || !principal) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background p-6 text-foreground">
        <section className="w-full max-w-md space-y-3 rounded-lg border border-border p-6">
          <h1 className="text-xl font-semibold">Authorize CLI</h1>
          <p className="text-sm text-destructive">Sign-in is unavailable right now.</p>
        </section>
      </main>
    );
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-6 text-foreground">
      <section className="w-full max-w-md space-y-4 rounded-lg border border-border p-6">
        <div className="space-y-2">
          <h1 className="text-xl font-semibold">Authorize CLI</h1>
          <p className="text-sm text-muted">
            Approve one CLI credential for the account connected to this user.
          </p>
        </div>
        {approved ? (
          <p role="status" className="text-sm text-green-600">
            CLI authorized. Return to your terminal.
          </p>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void (prepared ? approve() : prepare());
            }}
          >
            <label className="block space-y-2 text-sm" htmlFor="cli-user-code">
              Authorization code
              <Input
                id="cli-user-code"
                value={userCode}
                onChange={(event) => {
                  setUserCode(event.target.value);
                  setPrepared(null);
                }}
                placeholder="ABCD-EFGH-JKLM"
                autoComplete="off"
              />
            </label>
            <label className="block space-y-2 text-sm" htmlFor="cli-account-id">
              Account ID
              <Input
                id="cli-account-id"
                value={accountId}
                onChange={(event) => {
                  setAccountId(event.target.value);
                  setPrepared(null);
                }}
                placeholder="Account ID"
                autoComplete="off"
              />
            </label>
            {error ? (
              <p role="status" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            {prepared ? (
              <div className="space-y-1 rounded-md border border-border p-3 text-sm">
                <p>
                  CLI: <strong>{prepared.clientName || "Unnamed CLI"}</strong>
                </p>
                {prepared.authoring ? (
                  <p>This CLI will receive delegated authoring access from the unlocked local vault.</p>
                ) : (
                  <p>This CLI requested read-only access.</p>
                )}
              </div>
            ) : null}
            <Button
              type="submit"
              disabled={pending || !principal || !normalizedUserCode || !accountId.trim()}
            >
              {pending ? "Authorizing..." : prepared ? "Authorize CLI" : "Review CLI"}
            </Button>
          </form>
        )}
      </section>
    </main>
  );
};

export default CliAuthPage;

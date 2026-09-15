import React, { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  beginOpenAuthLogin,
  getOpenAuthPrincipal,
  logoutOpenAuth,
  type OpenAuthPrincipal,
} from "@/lib/auth/openAuthClient";
import { clearAccountSession } from "@/lib/auth/accountSession";
import {
  AccountSyncUploadUncertainError,
  RecoveryPackageMismatchError,
  cancelAccountSyncOperations,
  confirmAccountSyncRecoveryCode,
  getAccountSyncState,
  restoreAccountSync,
  setupAccountSync,
  type AccountSyncState,
} from "@/lib/auth/accountSyncClient";
import {
  LOCAL_ACCOUNT_VAULT_CHANGED_EVENT,
  setActiveVaultUser,
} from "@/lib/void/vault/passkeyVault";

const controlClassName = "border-border text-muted hover:text-foreground";

interface OpenAuthAccountControlProps {
  onSyncReady?: () => void;
  onSignedOut?: () => void;
}

const OpenAuthAccountControl: React.FC<OpenAuthAccountControlProps> = ({
  onSyncReady,
  onSignedOut,
}) => {
  const [principal, setPrincipal] = useState<OpenAuthPrincipal | null | undefined>(
    undefined,
  );
  const [logoutPending, setLogoutPending] = useState(false);
  const [logoutError, setLogoutError] = useState(false);
  const [syncState, setSyncState] = useState<AccountSyncState | null>(null);
  const [syncOpen, setSyncOpen] = useState(false);
  const [syncPending, setSyncPending] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [recoveryCode, setRecoveryCode] = useState("");
  const [generatedRecoveryCode, setGeneratedRecoveryCode] = useState<string | null>(null);
  const [generatedRecoveryDigest, setGeneratedRecoveryDigest] = useState<string | null>(null);
  const [canDiscardRecoveryCode, setCanDiscardRecoveryCode] = useState(false);
  const [replaceLocalAccount, setReplaceLocalAccount] = useState(false);

  useEffect(() => {
    let active = true;

    void getOpenAuthPrincipal().then((nextPrincipal) => {
      if (active) {
        setActiveVaultUser(nextPrincipal?.userId ?? null);
        setPrincipal(nextPrincipal);
      }
    });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    const refreshSyncState = (): void => {
      if (!principal) {
        setSyncState(null);
        return;
      }
      void getAccountSyncState(principal)
        .then((state) => {
          if (active) {
            setSyncError(null);
            setSyncState(state);
          }
        })
        .catch(() => {
          if (active) setSyncError("Sync status unavailable");
        });
    };

    if (!principal) {
      setSyncState(null);
      return () => {
        active = false;
      };
    }
    refreshSyncState();
    window.addEventListener("focus", refreshSyncState);
    window.addEventListener("storage", refreshSyncState);
    window.addEventListener(LOCAL_ACCOUNT_VAULT_CHANGED_EVENT, refreshSyncState);
    return () => {
      active = false;
      window.removeEventListener("focus", refreshSyncState);
      window.removeEventListener("storage", refreshSyncState);
      window.removeEventListener(LOCAL_ACCOUNT_VAULT_CHANGED_EVENT, refreshSyncState);
    };
  }, [principal]);

  const handleLogout = async (): Promise<void> => {
    if (!principal || logoutPending) {
      return;
    }

    setLogoutPending(true);
    setLogoutError(false);
    cancelAccountSyncOperations();
    if (await logoutOpenAuth()) {
      clearAccountSession();
      setActiveVaultUser(null);
      setSyncOpen(false);
      setGeneratedRecoveryCode(null);
      setGeneratedRecoveryDigest(null);
      setRecoveryCode("");
      setSyncError(null);
      setPrincipal(null);
      onSignedOut?.();
    } else {
      setLogoutError(true);
    }
    setLogoutPending(false);
  };

  const handleSync = async (): Promise<void> => {
    if (!principal || !syncState || syncPending) return;
    setSyncPending(true);
    setSyncError(null);
    try {
      if (
        syncState.status === "setup" ||
        syncState.status === "ready" ||
        syncState.status === "unconfirmed"
      ) {
        const result = await setupAccountSync(
          principal,
          syncState.status === "setup" ? 1 : syncState.revision + 1,
        );
        setGeneratedRecoveryCode(result.recoveryCode);
        setGeneratedRecoveryDigest(result.ciphertextDigest);
        setCanDiscardRecoveryCode(false);
        setSyncState({
          status: "ready",
          accountId: result.accountId,
          revision: result.revision,
        });
      } else if (syncState.status === "restore") {
        const result = await restoreAccountSync(principal, recoveryCode, {
          allowReplaceLocalAccount: replaceLocalAccount,
        });
        setSyncState({
          status: "ready",
          accountId: result.accountId,
          revision: syncState.package.metadata.revision,
        });
        setRecoveryCode("");
        setReplaceLocalAccount(false);
        setSyncOpen(false);
        onSyncReady?.();
      }
    } catch (error) {
      if (error instanceof AccountSyncUploadUncertainError) {
        setGeneratedRecoveryCode(error.recoveryCode);
        setGeneratedRecoveryDigest(error.ciphertextDigest);
        setCanDiscardRecoveryCode(false);
        setSyncState({
          status: "unconfirmed",
          accountId: error.accountId,
          revision: error.revision,
        });
      }
      setSyncError(error instanceof Error ? error.message : "Sync failed");
    } finally {
      setSyncPending(false);
    }
  };

  const handleRecoveryCodeSaved = async (): Promise<void> => {
    if (
      syncState?.status !== "ready" &&
      syncState?.status !== "unconfirmed" ||
      !generatedRecoveryDigest
    ) {
      return;
    }
    setSyncPending(true);
    setSyncError(null);
    try {
      await confirmAccountSyncRecoveryCode(
        syncState.accountId,
        syncState.revision,
        generatedRecoveryDigest,
      );
      setGeneratedRecoveryCode(null);
      setGeneratedRecoveryDigest(null);
      setCanDiscardRecoveryCode(false);
      setSyncOpen(false);
      onSyncReady?.();
    } catch (error) {
      if (error instanceof RecoveryPackageMismatchError) {
        setCanDiscardRecoveryCode(true);
      }
      setSyncError(error instanceof Error ? error.message : "Sync confirmation failed");
    } finally {
      setSyncPending(false);
    }
  };

  if (principal === undefined) {
    return (
      <Button
        type="button"
        disabled
        variant="outline"
        size="sm"
        className={controlClassName}
      >
        Checking account...
      </Button>
    );
  }

  if (!principal) {
    return (
      <Button
        type="button"
        onClick={() => beginOpenAuthLogin()}
        variant="outline"
        size="sm"
        className={controlClassName}
        title="Sign in to sync private-drop keys across browsers."
      >
        Sign in
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <span
        className="rounded-full border border-border px-2 py-1 text-xs text-muted"
        title={
          syncState?.status === "ready"
            ? "Private-drop keys are available on this browser."
            : syncState?.status === "unconfirmed"
              ? "Replace the recovery code before relying on browser recovery."
            : "Signed in. Set up sync to use private drops on another browser."
        }
      >
        {syncState?.status === "ready"
          ? "Synced"
          : syncState?.status === "unconfirmed"
            ? "Recovery code required"
            : "Signed in"}
      </span>
      {syncState ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={controlClassName}
          onClick={() => {
            setSyncError(null);
            setGeneratedRecoveryCode(null);
            setGeneratedRecoveryDigest(null);
            setCanDiscardRecoveryCode(false);
            setReplaceLocalAccount(false);
            setSyncOpen(true);
          }}
          disabled={syncState.status === "empty"}
        >
          {syncState.status === "setup"
            ? "Set up sync"
              : syncState.status === "restore"
               ? "Sync this browser"
              : syncState.status === "ready" || syncState.status === "unconfirmed"
                ? "Replace recovery code"
                : "Local content needed"}
        </Button>
      ) : null}
      {logoutError ? (
        <span role="status" className="text-xs text-destructive">
          Sign out failed
        </span>
      ) : null}
      <Button
        type="button"
        onClick={() => void handleLogout()}
        disabled={logoutPending || syncPending}
        variant="outline"
        size="sm"
        className={controlClassName}
      >
        {logoutPending ? "Signing out..." : "Sign out"}
      </Button>
      <Dialog
        open={syncOpen}
        onOpenChange={(open) => {
          if (!open && (generatedRecoveryCode || syncPending)) return;
          setSyncOpen(open);
        }}
      >
        <DialogContent className="w-[min(30rem,calc(100vw-2rem))] max-w-none">
          <DialogHeader>
            <DialogTitle>
              {syncState?.status === "restore"
                ? "Sync this browser"
                : syncState?.status === "ready" || syncState?.status === "unconfirmed"
                  ? "Replace recovery code"
                  : "Set up sync"}
            </DialogTitle>
            <DialogDescription>
              {syncState?.status === "restore"
                ? "Enter your recovery code to restore the same private-drop keys on this browser. Existing local account data will be preserved."
                : syncState?.status === "ready" || syncState?.status === "unconfirmed"
                  ? "Create a new recovery code and replace the previous encrypted recovery package."
                  : "Encrypt this browser's private-drop keys for recovery on another signed-in browser."}
            </DialogDescription>
          </DialogHeader>
          {syncState?.status === "restore" ? (
            <div className="space-y-3">
              <Input
                aria-label="Recovery code"
                autoComplete="off"
                value={recoveryCode}
                onChange={(event) => setRecoveryCode(event.target.value)}
                placeholder="Recovery code"
              />
              {syncState.localAccountId &&
              syncState.localAccountId !== syncState.accountId ? (
                <label className="flex items-start gap-2 text-left text-xs text-muted">
                  <input
                    type="checkbox"
                    checked={replaceLocalAccount}
                    onChange={(event) => setReplaceLocalAccount(event.target.checked)}
                  />
                  Replace the active local account. Its keys will be archived in this browser,
                  but this release does not yet provide an account switcher.
                </label>
              ) : null}
            </div>
          ) : null}
          {generatedRecoveryCode ? (
            <div className="space-y-2 rounded-md border border-border bg-muted/20 p-3">
              <p className="text-sm font-medium">Save this recovery code now</p>
              <code className="block break-all text-xs" data-testid="generated-recovery-code">
                {generatedRecoveryCode}
              </code>
              <p className="text-xs text-muted">
                Nulldown cannot recover this code. It is not stored by the service.
              </p>
            </div>
          ) : null}
          {syncError ? (
            <p role="status" className="text-sm text-destructive">
              {syncError}
            </p>
          ) : null}
          <DialogFooter>
            {generatedRecoveryCode ? (
              <>
                {canDiscardRecoveryCode ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => window.location.reload()}
                  >
                    Discard invalid code
                  </Button>
                ) : null}
                <Button
                  type="button"
                  disabled={syncPending}
                  onClick={() => void handleRecoveryCodeSaved()}
                >
                  {syncPending ? "Checking..." : "I saved it"}
                </Button>
              </>
            ) : (
              <Button
                type="button"
                onClick={() => void handleSync()}
                disabled={
                  syncPending ||
                  !syncState ||
                  syncState.status === "empty" ||
                  (syncState.status === "restore" && !recoveryCode.trim()) ||
                  (syncState.status === "restore" &&
                    Boolean(syncState.localAccountId) &&
                    syncState.localAccountId !== syncState.accountId &&
                    !replaceLocalAccount)
                }
              >
                {syncPending
                  ? "Syncing..."
                  : syncState?.status === "restore"
                    ? "Restore account"
                    : syncState?.status === "ready" ||
                        syncState?.status === "unconfirmed"
                      ? "Replace recovery code"
                      : "Create recovery code"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default OpenAuthAccountControl;

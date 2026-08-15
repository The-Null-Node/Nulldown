import React, { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  beginOpenAuthLogin,
  getOpenAuthPrincipal,
  logoutOpenAuth,
  type OpenAuthPrincipal,
} from "@/lib/auth/openAuthClient";

const controlClassName = "border-border text-muted hover:text-foreground";

const OpenAuthAccountControl: React.FC = () => {
  const [principal, setPrincipal] = useState<OpenAuthPrincipal | null | undefined>(
    undefined,
  );
  const [logoutPending, setLogoutPending] = useState(false);
  const [logoutError, setLogoutError] = useState(false);

  useEffect(() => {
    let active = true;

    void getOpenAuthPrincipal().then((nextPrincipal) => {
      if (active) {
        setPrincipal(nextPrincipal);
      }
    });

    return () => {
      active = false;
    };
  }, []);

  const handleLogout = async (): Promise<void> => {
    if (!principal || logoutPending) {
      return;
    }

    setLogoutPending(true);
    setLogoutError(false);
    if (await logoutOpenAuth()) {
      setPrincipal(null);
    } else {
      setLogoutError(true);
    }
    setLogoutPending(false);
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
        title="Sign in to OpenAuth. Legacy Nulldown branch access remains separate."
      >
        Sign in
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <span
        className="rounded-full border border-border px-2 py-1 text-xs text-muted"
        title="OpenAuth identity only. Legacy Nulldown branch access remains separate."
      >
        Signed in
      </span>
      {logoutError ? (
        <span role="status" className="text-xs text-destructive">
          Sign out failed
        </span>
      ) : null}
      <Button
        type="button"
        onClick={() => void handleLogout()}
        disabled={logoutPending}
        variant="outline"
        size="sm"
        className={controlClassName}
      >
        {logoutPending ? "Signing out..." : "Sign out"}
      </Button>
    </div>
  );
};

export default OpenAuthAccountControl;

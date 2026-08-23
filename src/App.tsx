import React, { useEffect, useState } from "react";
import { BrowserRouter as Router, Routes, Route, Link } from "react-router-dom";
import EditorPage from "./pages/EditorPage";
import DropViewPage from "./pages/DropViewPage";
import CliAuthPage from "./pages/CliAuthPage";
import { ThemeProvider } from "./theme/themeContext";
import {
  getOpenAuthSessionState,
  OPEN_AUTH_LOGOUT_STORAGE_KEY,
} from "./lib/auth/openAuthClient";
import {
  cancelAccountSyncOperations,
  getAccountSyncState,
} from "./lib/auth/accountSyncClient";
import { clearAccountSession } from "./lib/auth/accountSession";
import { setActiveVaultUser } from "./lib/void/vault/passkeyVault";
import OpenAuthAccountControl from "./pages/editor/components/OpenAuthAccountControl";

// A simple 404 component
const NotFoundPage: React.FC = () => {
  return (
    <div className="flex-1 flex flex-col items-center justify-center p-4">
      <h1 className="text-4xl font-bold mb-4">404</h1>
      <p className="text-muted mb-8">
        Oops! The page you're looking for doesn't exist.
      </p>
      <Link to="/" className="text-accent hover:underline">
        Go to Homepage
      </Link>
    </div>
  );
};

const App: React.FC = () => {
  const [accountReady, setAccountReady] = useState(false);
  const [restoreRequired, setRestoreRequired] = useState(false);

  useEffect(() => {
    const handleRemoteLogout = (event: StorageEvent): void => {
      if (event.key !== OPEN_AUTH_LOGOUT_STORAGE_KEY) return;
      cancelAccountSyncOperations();
      clearAccountSession();
      setActiveVaultUser(null);
      window.location.reload();
    };
    window.addEventListener("storage", handleRemoteLogout);
    return () => window.removeEventListener("storage", handleRemoteLogout);
  }, []);

  useEffect(() => {
    let active = true;
    setAccountReady(false);
    setRestoreRequired(false);
    void getOpenAuthSessionState().then(async (session) => {
      if (!active) return;
      if (session.status === "unavailable") {
        clearAccountSession();
        setActiveVaultUser(null);
        setAccountReady(true);
        return;
      }
      const principal =
        session.status === "authenticated" ? session.principal : null;
      clearAccountSession();
      setActiveVaultUser(principal?.userId ?? null);
      if (principal) {
        try {
          const syncState = await getAccountSyncState(principal);
          if (!active) return;
          setRestoreRequired(syncState.status === "restore");
        } catch {
          if (active) setAccountReady(true);
          return;
        }
      }
      if (active) setAccountReady(true);
    });
    return () => {
      active = false;
    };
  }, []);

  if (!accountReady) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background text-sm text-muted">
        Loading account...
      </div>
    );
  }

  if (typeof window !== "undefined" && window.location.pathname === "/auth/cli") {
    return (
      <ThemeProvider>
        <CliAuthPage />
      </ThemeProvider>
    );
  }

  if (restoreRequired) {
    return (
      <ThemeProvider>
        <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-background p-6 text-center text-foreground">
          <div className="max-w-md space-y-2">
            <h1 className="text-xl font-semibold">Sync this browser first</h1>
            <p className="text-sm text-muted">
              Restore your private-drop keys before opening account-owned content. Any different local account is preserved.
            </p>
          </div>
          <OpenAuthAccountControl
            onSyncReady={() => setRestoreRequired(false)}
            onSignedOut={() => setRestoreRequired(false)}
          />
        </div>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider>
      <Router>
        <div style={{ position: "fixed", inset: 0 }}>
          <Routes>
            <Route path="/" element={<EditorPage />} />
            <Route path="/d/:id" element={<DropViewPage />} />
            <Route path="/auth/cli" element={<CliAuthPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </div>
      </Router>
    </ThemeProvider>
  );
};

export default App;

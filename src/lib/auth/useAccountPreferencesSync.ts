import { useEffect } from "react";
import type { OpenAuthPrincipal } from "./openAuthClient";
import { useAccountPreferencesStore } from "../../stores/accountPreferencesStore";

/** Hydrates cached preferences, then refreshes them for the current OpenAuth user. */
export const useAccountPreferencesSync = (principal: OpenAuthPrincipal | null): void => {
  const connect = useAccountPreferencesStore((state) => state.connect);
  const refresh = useAccountPreferencesStore((state) => state.refresh);

  useEffect(() => {
    void connect(principal?.userId ?? null);
  }, [connect, principal?.userId]);

  useEffect(() => {
    const refreshWhenOnline = () => void refresh();
    window.addEventListener("online", refreshWhenOnline);
    window.addEventListener("focus", refreshWhenOnline);
    return () => {
      window.removeEventListener("online", refreshWhenOnline);
      window.removeEventListener("focus", refreshWhenOnline);
    };
  }, [refresh]);
};

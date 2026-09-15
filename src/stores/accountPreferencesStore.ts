import { create } from "zustand";
import {
  ACCOUNT_PREFERENCE_FIELDS,
  ACCOUNT_PREFERENCE_MUTATION_SCHEMA_V1,
  createDefaultAccountPreferences,
  isAccountPreferences,
  type AccountPreferenceField,
  type AccountPreferenceMutation,
  type AccountPreferenceValues,
  type AccountPreferences,
  type VersionedAccountPreference,
} from "../../shared/auth/accountPreferences";
import {
  AccountPreferenceConflictError,
  fetchAccountPreferences,
  updateAccountPreference,
} from "../lib/auth/accountPreferencesClient";
import { readPersistedValue, writePersistedValue } from "./drop/settings";
import useDropStore from "./dropStore";
import { useThemeStore } from "../theme/themeContext";

const CACHE_KEY_PREFIX = "nulldown_account_preferences_v1:";

interface CachedAccountPreferences {
  userId: string;
  snapshot: AccountPreferences;
}

export type AccountPreferenceStatus = "idle" | "pending" | "synced" | "local" | "conflict" | "error";

interface AccountPreferencesState {
  userId: string | null;
  snapshot: AccountPreferences | null;
  status: Partial<Record<AccountPreferenceField, AccountPreferenceStatus>>;
  message: string | null;
  connect: (userId: string | null) => Promise<void>;
  refresh: () => Promise<void>;
  setPreference: (
    field: AccountPreferenceField,
    value: AccountPreferenceValues[AccountPreferenceField],
  ) => Promise<void>;
}

const cacheKey = (userId: string): string => `${CACHE_KEY_PREFIX}${userId}`;

const isCachedAccountPreferences = (value: unknown): value is CachedAccountPreferences =>
  Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as { userId?: unknown }).userId === "string" &&
      isAccountPreferences((value as { snapshot?: unknown }).snapshot),
  );

const setStatus = (
  set: (partial: Partial<AccountPreferencesState>) => void,
  get: () => AccountPreferencesState,
  field: AccountPreferenceField,
  status: AccountPreferenceStatus,
  message: string | null,
) =>
  set({
    status: { ...get().status, [field]: status },
    message,
  });

const applyLocalPreference = async (
  field: AccountPreferenceField,
  value: AccountPreferenceValues[AccountPreferenceField],
): Promise<void> => {
  if (field === "theme") {
    await useThemeStore
      .getState()
      .setPreferredThemeId(value as AccountPreferenceValues["theme"]);
    return;
  }
  if (field === "typeface") {
    useThemeStore.getState().setTypefaceId(value as AccountPreferenceValues["typeface"]);
    return;
  }
  if (field === "syntaxMode") {
    await useDropStore.getState().setSyntaxMode(value as AccountPreferenceValues["syntaxMode"]);
    return;
  }
  await useDropStore
    .getState()
    .setShareVisibility(value as AccountPreferenceValues["shareVisibilityDefault"]);
};

const readLocalPreference = (
  field: AccountPreferenceField,
): AccountPreferenceValues[AccountPreferenceField] => {
  if (field === "theme") return useThemeStore.getState().preferredThemeId as AccountPreferenceValues["theme"];
  if (field === "typeface") return useThemeStore.getState().typefaceId as AccountPreferenceValues["typeface"];
  if (field === "syntaxMode") return useDropStore.getState().syntaxMode as AccountPreferenceValues["syntaxMode"];
  return useDropStore.getState().shareVisibility as AccountPreferenceValues["shareVisibilityDefault"];
};

const withUpdatedField = (
  snapshot: AccountPreferences,
  field: AccountPreferenceField,
  current: VersionedAccountPreference<AccountPreferenceField>,
): AccountPreferences => ({
  ...snapshot,
  fields: {
    theme: field === "theme" ? current as AccountPreferences["fields"]["theme"] : snapshot.fields.theme,
    typeface: field === "typeface" ? current as AccountPreferences["fields"]["typeface"] : snapshot.fields.typeface,
    syntaxMode: field === "syntaxMode" ? current as AccountPreferences["fields"]["syntaxMode"] : snapshot.fields.syntaxMode,
    shareVisibilityDefault:
      field === "shareVisibilityDefault"
        ? current as AccountPreferences["fields"]["shareVisibilityDefault"]
        : snapshot.fields.shareVisibilityDefault,
  },
});

const persistSnapshot = async (userId: string, snapshot: AccountPreferences): Promise<void> => {
  await writePersistedValue(cacheKey(userId), { userId, snapshot } satisfies CachedAccountPreferences);
};

export const useAccountPreferencesStore = create<AccountPreferencesState>((set, get) => ({
  userId: null,
  snapshot: null,
  status: {},
  message: null,
  connect: async (userId) => {
    if (!userId) {
      set({ userId: null, snapshot: null, status: {}, message: null });
      return;
    }
    set({ userId, snapshot: null, status: {}, message: null });
    const cached = await readPersistedValue<CachedAccountPreferences>(cacheKey(userId));
    if (get().userId !== userId) return;
    if (isCachedAccountPreferences(cached) && cached.userId === userId) {
      for (const field of ACCOUNT_PREFERENCE_FIELDS) {
        await applyLocalPreference(field, cached.snapshot.fields[field].value);
      }
      set({ userId, snapshot: cached.snapshot });
    } else {
      set({ userId, snapshot: createDefaultAccountPreferences() });
    }
    await get().refresh();
  },
  refresh: async () => {
    const userId = get().userId;
    if (!userId || typeof navigator !== "undefined" && !navigator.onLine) return;
    try {
      const remote = await fetchAccountPreferences();
      if (get().userId !== userId) return;
      const previous = get().snapshot;
      const merged = remote;
      for (const field of ACCOUNT_PREFERENCE_FIELDS) {
        if (!previous || remote.fields[field].revision > previous.fields[field].revision) {
          await applyLocalPreference(field, remote.fields[field].value);
        }
      }
      set({ snapshot: merged, message: null });
      await persistSnapshot(userId, merged);

      // Seed only fields absent on the server, preserving an existing device's local choices.
      for (const field of ACCOUNT_PREFERENCE_FIELDS) {
        if (remote.fields[field].revision === 0) {
          const localValue = readLocalPreference(field);
          if (localValue !== remote.fields[field].value) {
            await get().setPreference(field, localValue);
          }
        }
      }
    } catch {
      if (get().userId === userId) {
        set({ message: "Using local preferences until account sync is available." });
      }
    }
  },
  setPreference: async (field, value) => {
    const userId = get().userId;
    if (!userId || (typeof navigator !== "undefined" && !navigator.onLine)) {
      await applyLocalPreference(field, value);
      setStatus(set, get, field, "local", "Saved only on this device while offline.");
      return;
    }
    const snapshot = get().snapshot ?? createDefaultAccountPreferences();
    if (get().status[field] === "pending") return;
    setStatus(set, get, field, "pending", null);
    try {
      const { current } = await updateAccountPreference({
        schema: ACCOUNT_PREFERENCE_MUTATION_SCHEMA_V1,
        version: 1,
        field,
        value,
        expectedRevision: snapshot.fields[field].revision,
      } as AccountPreferenceMutation);
      if (get().userId !== userId) return;
      const next = withUpdatedField(snapshot, field, current);
      await applyLocalPreference(field, current.value);
      set({ snapshot: next });
      await persistSnapshot(userId, next);
      setStatus(set, get, field, "synced", "Saved to your account.");
    } catch (error) {
      if (get().userId !== userId) return;
      if (error instanceof AccountPreferenceConflictError) {
        const next = withUpdatedField(snapshot, field, error.current);
        await applyLocalPreference(field, error.current.value);
        set({ snapshot: next });
        await persistSnapshot(userId, next);
        setStatus(set, get, field, "conflict", "A newer setting from another device was applied.");
        return;
      }
      setStatus(set, get, field, "error", "Could not save this preference to your account.");
    }
  },
}));

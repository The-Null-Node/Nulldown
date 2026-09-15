import {
  createDefaultAccountPreferences,
  isAccountPreferenceValue,
  parseAccountPreferenceMutation,
  type AccountPreferenceField,
  type AccountPreferences,
  type VersionedAccountPreference,
} from "../../../../../shared/auth/accountPreferences";
import {
  advanceAccountPreferenceField,
  listAccountPreferenceRows,
  type AccountPreferenceRow,
} from "./repository";
import {
  isSameOriginOpenAuthRequest,
  resolveOpenAuthRequestIdentity,
  type OpenAuthBffEnvironment,
} from "../openAuth/service";

export class AccountPreferencesError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const toVersionedPreference = <F extends AccountPreferenceField>(
  field: F,
  row: AccountPreferenceRow,
): VersionedAccountPreference<F> | null =>
  isAccountPreferenceValue(field, row.preference_value) &&
  Number.isSafeInteger(row.revision) &&
  row.revision > 0 &&
  Number.isSafeInteger(row.updated_at) &&
  row.updated_at >= 0
    ? {
        value: row.preference_value as VersionedAccountPreference<F>["value"],
        revision: row.revision,
        updatedAt: row.updated_at,
      }
    : null;

const toSnapshot = (rows: AccountPreferenceRow[]): AccountPreferences => {
  const defaults = createDefaultAccountPreferences();
  const rowFor = (field: AccountPreferenceField) =>
    rows.find((candidate) => candidate.preference_key === field);
  const theme = rowFor("theme");
  const typeface = rowFor("typeface");
  const syntaxMode = rowFor("syntaxMode");
  const shareVisibilityDefault = rowFor("shareVisibilityDefault");
  return {
    ...defaults,
    fields: {
      theme: theme ? toVersionedPreference("theme", theme) ?? defaults.fields.theme : defaults.fields.theme,
      typeface: typeface
        ? toVersionedPreference("typeface", typeface) ?? defaults.fields.typeface
        : defaults.fields.typeface,
      syntaxMode: syntaxMode
        ? toVersionedPreference("syntaxMode", syntaxMode) ?? defaults.fields.syntaxMode
        : defaults.fields.syntaxMode,
      shareVisibilityDefault: shareVisibilityDefault
        ? toVersionedPreference("shareVisibilityDefault", shareVisibilityDefault) ?? defaults.fields.shareVisibilityDefault
        : defaults.fields.shareVisibilityDefault,
    },
  };
};

const responseJson = (body: unknown, headers: Headers, status = 200): Response => {
  headers.set("Content-Type", "application/json");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(body), { status, headers });
};

/** Reads all bounded preferences for the authenticated OpenAuth user. */
export const readAccountPreferencesResponse = async (
  env: OpenAuthBffEnvironment,
  request: Request,
): Promise<Response> => {
  const identity = await resolveOpenAuthRequestIdentity(env, request);
  if (identity instanceof Response) return identity;
  try {
    return responseJson(
      toSnapshot(await listAccountPreferenceRows(identity.db, identity.userId)),
      identity.responseHeaders,
    );
  } catch {
    throw new AccountPreferencesError(
      503,
      "account_preferences_unavailable",
      "Account preferences are unavailable.",
    );
  }
};

/** Applies a one-field revisioned mutation for the cookie-authenticated OpenAuth user. */
export const updateAccountPreferenceResponse = async (
  env: OpenAuthBffEnvironment,
  request: Request,
): Promise<Response> => {
  const identity = await resolveOpenAuthRequestIdentity(env, request);
  if (identity instanceof Response) return identity;
  if (!isSameOriginOpenAuthRequest(request, identity.origin)) {
    throw new AccountPreferencesError(403, "invalid_origin", "Preference updates require the same origin.");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new AccountPreferencesError(400, "invalid_account_preference", "Preference input must be JSON.");
  }
  const mutation = parseAccountPreferenceMutation(body);
  if (!mutation) {
    throw new AccountPreferencesError(400, "invalid_account_preference", "Preference input is invalid.");
  }

  try {
    const result = await advanceAccountPreferenceField(identity.db, {
      userId: identity.userId,
      field: mutation.field,
      value: mutation.value,
      expectedRevision: mutation.expectedRevision,
      updatedAt: Date.now(),
    });
    const current = result.current && toVersionedPreference(mutation.field, result.current);
    if (!current) {
      throw new AccountPreferencesError(
        503,
        "account_preferences_unavailable",
        "Account preferences are unavailable.",
      );
    }
    if (!result.applied) {
      return responseJson(
        { error: "preference_revision_conflict", current },
        identity.responseHeaders,
        409,
      );
    }
    return responseJson({ field: mutation.field, current }, identity.responseHeaders);
  } catch (error) {
    if (error instanceof AccountPreferencesError) throw error;
    throw new AccountPreferencesError(
      503,
      "account_preferences_unavailable",
      "Account preferences are unavailable.",
    );
  }
};

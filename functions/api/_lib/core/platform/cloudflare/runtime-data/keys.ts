import type {
  RuntimeDataKey,
  RuntimeDataPrimitive,
  RuntimeDataScope,
} from "../../../../../../../src/server/ports";

const DATA_LOCK_PREFIX = "void-data-locks";

const encodeKeySegment = (value: string): string => encodeURIComponent(value);

/** Returns stable, sorted scope entries for persisted runtime-data keys. */
export const runtimeDataScopeEntries = (
  scope: RuntimeDataScope | undefined,
): Array<[string, RuntimeDataPrimitive]> =>
  Object.entries(scope ?? {}).sort(([left], [right]) =>
    left.localeCompare(right),
  );

const scopeSegment = (entry: [string, RuntimeDataPrimitive]): string => {
  const [key, value] = entry;
  return `${encodeKeySegment(key)}=${encodeKeySegment(JSON.stringify(value))}`;
};

/** Normalizes an absent runtime-data collection for D1 persistence. */
export const normalizeRuntimeDataCollection = (
  collection: string | undefined,
): string => collection ?? "";

/** Serializes a runtime-data scope into its stable D1 key representation. */
export const resolveRuntimeDataScopeKey = (
  scope: RuntimeDataScope | undefined,
): string => runtimeDataScopeEntries(scope).map(scopeSegment).join("/");

/** Creates the stable R2 lock key for one runtime-data record. */
export const resolveRuntimeDataLockKey = (key: RuntimeDataKey): string =>
  [
    DATA_LOCK_PREFIX,
    encodeKeySegment(key.namespace),
    encodeKeySegment(key.collection ?? "_"),
    ...runtimeDataScopeEntries(key.scope).map(scopeSegment),
    encodeKeySegment(key.id),
  ].join("/");

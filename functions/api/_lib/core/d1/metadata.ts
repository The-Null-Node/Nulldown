import type { VoidSqlStore } from "../../../../../src/server/ports";

/** JSON-compatible primitive values accepted by D1 bind parameters. */
export type D1BindableValue = string | number | null;

/** Minimal SQL binding shape used by metadata repositories. */
export type MetadataSqlStore = Pick<VoidSqlStore, "prepare" | "batch">;

/** Converts booleans to SQLite integer flags. */
export const booleanToSqlite = (value: boolean): number => (value ? 1 : 0);

/** Converts SQLite integer flags to booleans. */
export const sqliteToBoolean = (value: unknown): boolean => value === 1 || value === true;

/** Parses a JSON column through a type guard. */
export const parseJsonColumn = <T>(
  value: unknown,
  guard: (parsed: unknown) => parsed is T,
): T | null => {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return guard(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

/** Serializes a value for storage in a JSON text column. */
export const toJsonColumn = (value: unknown): string => JSON.stringify(value);

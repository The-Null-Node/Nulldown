import type { JsonValue } from "../../nullplug/types";

export const jsonRecordWithDefinedValues = (
  entries: Record<string, JsonValue | undefined>,
): Record<string, JsonValue> =>
  Object.fromEntries(
    Object.entries(entries).filter(
      (entry): entry is [string, JsonValue] => entry[1] !== undefined,
    ),
  );

export const permissionLabel = (kind: string): string =>
  `permission:${kind.replace(/[^a-z0-9._:-]/gi, "-").toLowerCase()}`;

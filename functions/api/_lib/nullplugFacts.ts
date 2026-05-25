import type { R2Bucket } from "@cloudflare/workers-types";
import {
  isNullplugUiResponseFact,
  isNullplugUiStatePatchFact,
  isNullplugUiStateSnapshot,
  nullplugUiResponseFactPrefix,
  nullplugUiStatePatchFactPrefix,
  nullplugUiStateSnapshotPrefix,
  type NullplugUiResponseFact,
  type NullplugUiStatePatchFact,
  type NullplugUiStateSnapshot,
} from "../../../shared/nullplug/ui";

const listJsonByPrefix = async <T>(
  bucket: R2Bucket,
  prefix: string,
  guard: (value: unknown) => value is T,
): Promise<T[]> => {
  const items: T[] = [];
  let cursor: string | undefined;

  do {
    const listed = await bucket.list({ prefix, cursor, limit: 1000 });
    const values = await Promise.all(
      listed.objects.map(async (object) => {
        try {
          const stored = await bucket.get(object.key);
          if (!stored) return null;
          const parsed = await stored.json();
          return guard(parsed) ? parsed : null;
        } catch {
          return null;
        }
      }),
    );
    values.forEach((value) => {
      if (value) items.push(value);
    });
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  return items;
};

export const listNullplugUiResponseFacts = (
  bucket: R2Bucket,
  rootDropId: string,
  branchId?: string,
): Promise<NullplugUiResponseFact[]> =>
  listJsonByPrefix(
    bucket,
    nullplugUiResponseFactPrefix(rootDropId, branchId),
    isNullplugUiResponseFact,
  );

export const listNullplugUiStatePatchFacts = (
  bucket: R2Bucket,
  rootDropId: string,
  branchId?: string,
): Promise<NullplugUiStatePatchFact[]> =>
  listJsonByPrefix(
    bucket,
    nullplugUiStatePatchFactPrefix(rootDropId, branchId),
    isNullplugUiStatePatchFact,
  );

export const listNullplugUiStateSnapshots = (
  bucket: R2Bucket,
  rootDropId: string,
  branchId?: string,
): Promise<NullplugUiStateSnapshot[]> =>
  listJsonByPrefix(
    bucket,
    nullplugUiStateSnapshotPrefix(rootDropId, branchId),
    isNullplugUiStateSnapshot,
  );

export const listNullplugRuntimeFacts = async (
  bucket: R2Bucket,
  rootDropId: string,
  branchId?: string,
): Promise<{
  uiResponseFacts: NullplugUiResponseFact[];
  uiStatePatchFacts: NullplugUiStatePatchFact[];
  uiStateSnapshots: NullplugUiStateSnapshot[];
}> => {
  const [uiResponseFacts, uiStatePatchFacts, uiStateSnapshots] = await Promise.all([
    listNullplugUiResponseFacts(bucket, rootDropId, branchId),
    listNullplugUiStatePatchFacts(bucket, rootDropId, branchId),
    listNullplugUiStateSnapshots(bucket, rootDropId, branchId),
  ]);

  return { uiResponseFacts, uiStatePatchFacts, uiStateSnapshots };
};

import { createBuiltInNullMemCapabilities } from "../../../../shared/nullmem/capabilities/builtIns";
import { createRemoteNullplugCapabilityRecord } from "../../../../shared/nullmem/capabilities/remoteNullplug";
import { createThemeCatalogCapabilityRecords } from "../../../../shared/nullmem/capabilities/theme";
import type { NullMemRecord } from "../../../../shared/nullmem/types";
import {
  NULLPLUG_REGISTRY_LATEST_KEY_PREFIX,
  isRemoteNullplugRegistryRecord,
} from "../../../../shared/nullplug/registry";
import type { VoidBlobStore } from "../../../../src/server/ports";

/** Ports used by the optional NullMem capability catalog source. */
export interface NullMemCatalogSourcePorts {
  /** Blob store containing optional remote nullplug registry entries. */
  blobs: VoidBlobStore;
}

/** Source for derived capability records that are queried alongside persisted memory. */
export interface NullMemCatalogSource {
  /** Reads catalog records matching the requested memory kind. */
  readRecords(options?: { kind?: NullMemRecord["kind"] }): Promise<NullMemRecord[]>;
}

const readRemoteNullplugCapabilityRecords = async (
  store: VoidBlobStore,
): Promise<NullMemRecord[]> => {
  const records: NullMemRecord[] = [];
  let cursor: string | undefined;

  do {
    const listed = await store.list({
      prefix: NULLPLUG_REGISTRY_LATEST_KEY_PREFIX,
      cursor,
      limit: 200,
    });

    const pageRecords = await Promise.all(
      listed.objects.map(async (entry) => {
        const object = await store.get(entry.key);
        if (!object) return null;
        try {
          const parsed = await object.json();
          if (
            !isRemoteNullplugRegistryRecord(parsed) ||
            parsed.status !== "active"
          ) {
            return null;
          }
          return createRemoteNullplugCapabilityRecord(parsed);
        } catch {
          return null;
        }
      }),
    );

    records.push(
      ...pageRecords.filter(
        (record): record is NullMemRecord => record !== null,
      ),
    );
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  return records;
};

/** Creates the catalog source for built-in, theme, and remote nullplug capabilities. */
export const createNullMemCatalogSource = ({
  blobs,
}: NullMemCatalogSourcePorts): NullMemCatalogSource => ({
  readRecords: async ({ kind } = {}) => {
    if (kind && kind !== "capability") return [];

    const remoteNullplugCapabilities = await readRemoteNullplugCapabilityRecords(
      blobs,
    ).catch(() => []);

    return [
      ...createBuiltInNullMemCapabilities(0),
      ...createThemeCatalogCapabilityRecords(0),
      ...remoteNullplugCapabilities,
    ];
  },
});

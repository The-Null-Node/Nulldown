import {
  isRemoteNullplugManifest,
  isRemoteNullplugManifestAllowed,
  isRemoteNullplugRegistryRecord,
  readRemoteNullplugManifest,
  remoteNullplugLatestKey,
  remoteNullplugManifestKey,
  sanitizeNullplugRegistryKeyPart,
  writeRemoteNullplugManifest,
  type NullplugRegistryJsonStore,
  type RemoteNullplugRegistryRecord,
} from "./registry";

const createMemoryStore = (): NullplugRegistryJsonStore & {
  values: Map<string, string>;
  contentTypes: Map<string, string | undefined>;
} => {
  const values = new Map<string, string>();
  const contentTypes = new Map<string, string | undefined>();
  return {
    values,
    contentTypes,
    async get(key) {
      const value = values.get(key);
      if (value === undefined) return null;
      return {
        async json() {
          return JSON.parse(value) as unknown;
        },
      };
    },
    async put(key, value, options) {
      values.set(key, value);
      contentTypes.set(key, options?.httpMetadata?.contentType);
    },
  };
};

const record: RemoteNullplugRegistryRecord = {
  version: 1,
  manifest: {
    id: "remote.nd-summary",
    version: "1.0.0",
    endpoint: "https://plugins.nulldown.test/nd-summary",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    permissions: [
      { kind: "drop.read", scope: "caller" },
      { kind: "network", hosts: ["api.nulldown.test"] },
      { kind: "policy.evaluate" },
    ],
    description: "Summarizes linked Nulldown drops.",
  },
  status: "active",
  createdAt: 100,
  updatedAt: 101,
  registeredBy: "agent",
};

describe("remote nullplug registry helpers", () => {
  it("validates manifests and registry records", () => {
    expect(isRemoteNullplugManifest(record.manifest)).toBe(true);
    expect(isRemoteNullplugRegistryRecord(record)).toBe(true);
    expect(
      isRemoteNullplugManifest({
        ...record.manifest,
        permissions: [{ kind: "network", hosts: [42] }],
      }),
    ).toBe(false);
  });

  it("builds deterministic registry keys", () => {
    expect(sanitizeNullplugRegistryKeyPart("remote/plugin name")).toBe(
      "remote_plugin_name",
    );
    expect(remoteNullplugManifestKey("remote/plugin", "1.0.0")).toBe(
      "__nullplug_registry__/manifests/remote_plugin/1.0.0.json",
    );
    expect(remoteNullplugLatestKey("remote/plugin")).toBe(
      "__nullplug_registry__/latest/remote_plugin.json",
    );
  });

  it("gates manifests by endpoint and network permission hosts", () => {
    expect(
      isRemoteNullplugManifestAllowed(record.manifest, [
        "plugins.nulldown.test",
        "api.nulldown.test",
      ]),
    ).toBe(true);
    expect(
      isRemoteNullplugManifestAllowed(record.manifest, ["plugins.nulldown.test"]),
    ).toBe(false);
    expect(
      isRemoteNullplugManifestAllowed(
        { ...record.manifest, endpoint: "http://plugins.nulldown.test" },
        ["plugins.nulldown.test", "api.nulldown.test"],
      ),
    ).toBe(false);
  });

  it("writes versioned and latest registry records", async () => {
    const store = createMemoryStore();
    await writeRemoteNullplugManifest(store, record, [
      "plugins.nulldown.test",
      "api.nulldown.test",
    ]);

    const versionedKey = remoteNullplugManifestKey(
      record.manifest.id,
      record.manifest.version,
    );
    expect(store.contentTypes.get(versionedKey)).toBe("application/json");
    await expect(
      readRemoteNullplugManifest(
        store,
        record.manifest.id,
        record.manifest.version,
      ),
    ).resolves.toEqual(record);
    expect(store.values.has(remoteNullplugLatestKey(record.manifest.id))).toBe(true);
  });

  it("rejects disallowed registry records before writing", async () => {
    const store = createMemoryStore();
    await expect(
      writeRemoteNullplugManifest(store, record, ["plugins.nulldown.test"]),
    ).rejects.toThrow("Remote nullplug manifest is not allowed");
    expect(store.values.size).toBe(0);
  });
});

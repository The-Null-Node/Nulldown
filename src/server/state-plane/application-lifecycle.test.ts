import {
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync } from "node:fs";
import { encodeDropEnvelope } from "../../../shared/drop/codecs/envelope-v1";
import type {
  BranchStateTarget,
  BranchStateHead,
} from "../../../shared/drop/branch-state";
import type { BranchAuthorityRecord } from "../../../shared/drop/branch-lifecycle";
import {
  dropDiffEventMetadataSidecarKey,
  dropSnapshotMetadataSidecarKey,
  dropResolvedHeapKey,
} from "../../../shared/drop/sidecar";
import {
  nullplugUiResponseFactKey,
  nullplugUiStatePatchFactKey,
  nullplugUiStateSnapshotKey,
} from "../../../shared/nullplug/ui";
import { createDiffAuthCredentialKey } from "../../../functions/api/_lib/diffs/credentials/repository";
import { resolveRuntimeDataScopeKey } from "../../../functions/api/_lib/core/platform/cloudflare/runtime-data/keys";
import { createPromotedEnvelope } from "../../../functions/api/_lib/crypto/envelopes/promotion";
import { providerCrypto } from "../../../functions/api/_lib/crypto/provider-crypto";
import { MemoryR2Bucket } from "../../../functions/api/_lib/diffs/testing/storage-fixture";
import { readRootInitializationSource } from "../../../functions/api/_lib/branches/local-bootstrap";
import type { SqlMetadataStore, SqlStatement } from "../ports";
import { MemoryBranchCommitStatePlane } from "./memory-commits";
import {
  createLocalBranchLifecycle,
  type LocalBranchLifecycleOptions,
} from "./application-lifecycle";

const rootDropId = "lifecycle-root01";
const accountId = "owner-account";
const target = { rootDropId, branchId: "owner" };
const placement = { routingVersion: 1, generation: 3 };
const initialContent = "private source\n\u0000\ud800";
let encryptionKey: string;
let signingKey: string;
const databases: DatabaseSync[] = [];

beforeAll(async () => {
  const encryption = await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  );
  const signing = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  encryptionKey = JSON.stringify(
    await crypto.subtle.exportKey("jwk", encryption.privateKey),
  );
  signingKey = JSON.stringify(
    await crypto.subtle.exportKey("jwk", signing.privateKey),
  );
});
afterEach(() => {
  jest.restoreAllMocks();
  databases.splice(0).forEach((db) => db.close());
});

const fixture = async () => {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  for (const migration of [
    "0002_metadata.sql",
    "0003_void_data_store.sql",
    "0004_resolved_heap_delta.sql",
    "0005_resolved_node_payloads.sql",
    "0006_nullmem_records.sql",
    "0008_branch_runtime_facts.sql",
    "0012_account_remote_library.sql",
  ]) {
    database.exec(readFileSync(`migrations/${migration}`, "utf8"));
  }
  const sql: SqlMetadataStore = {
    prepare(query) {
      let bindings: SQLInputValue[] = [];
      const statement: SqlStatement = {
        bind(...values) {
          bindings = values as SQLInputValue[];
          return statement;
        },
        async run() {
          return database.prepare(query).run(...bindings);
        },
        async first<T>() {
          return (
            (database.prepare(query).get(...bindings) as T | undefined) ?? null
          );
        },
        async all<T>() {
          return { results: database.prepare(query).all(...bindings) as T[] };
        },
      };
      return statement;
    },
  };
  database
    .prepare(
      "INSERT INTO account_library_entries (drop_id, account_id, visibility, created_at, updated_at) VALUES (?, ?, 'unlisted', 1, 1)",
    )
    .run(rootDropId, accountId);
  const blobs = new MemoryR2Bucket();
  const envelope = await createPromotedEnvelope({
    content: initialContent,
    accountId,
    metadata: {},
    providerEncryptionPrivateJwk: encryptionKey,
    providerSigningPrivateJwk: signingKey,
  });
  const rootRevision = blobs.seed(
    rootDropId,
    JSON.stringify(encodeDropEnvelope(envelope)),
  );
  const backend = await MemoryBranchCommitStatePlane.create();
  const reserve = jest.spyOn(backend, "reserve");
  const initialize = jest.spyOn(backend, "initialize");
  const get = jest.spyOn(blobs, "get");
  const put = jest.spyOn(blobs, "put");
  const decrypt = jest.spyOn(providerCrypto, "unwrapProviderContentKey");
  const options: LocalBranchLifecycleOptions = {
    mode: "local-test",
    blobs,
    sql,
    backend,
    providerPrivateKey: encryptionKey,
    isEligibleRoot: (id) => id === rootDropId,
    initialPlacement: placement,
  };
  const lifecycle = createLocalBranchLifecycle(options);
  const resolve = (
    actor: string | null = accountId,
    client: string | null = "client-a",
  ) => lifecycle.resolveForActor(rootDropId, actor, client);
  return {
    options,
    lifecycle,
    resolve,
    database,
    sql,
    blobs,
    envelope,
    rootRevision,
    backend,
    reserve,
    initialize,
    get,
    put,
    decrypt,
  };
};

describe("selected local branch lifecycle", () => {
  it("preserves a valid 120-character account clone identity across resolution and retry", async () => {
    const f = await fixture();
    const writer = "w".repeat(120);
    const first = await f.resolve(writer, "first");
    const second = await f.resolve(writer, "second");
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(first.branch.branchId).toBe(`clone_account:${writer}`);
    expect(first.branch.branchId).toHaveLength(134);
    expect(second.branch).toEqual(first.branch);
    expect(
      await f.lifecycle.requireActivePlacement({
        rootDropId,
        branchId: first.branch.branchId,
      }),
    ).toEqual(placement);
  });

  it("ignores an abandoned root lease and resumes immediately without blob mutation", async () => {
    const f = await fixture();
    f.initialize.mockRejectedValueOnce(Error("process interrupted"));
    await expect(f.resolve()).rejects.toMatchObject({
      code: "state_unavailable",
    });
    f.blobs.seed(
      `__drop_root_lock__/${rootDropId}.json`,
      JSON.stringify({ token: "abandoned-process", createdAt: Date.now() }),
    );
    f.get.mockClear();
    const result = await createLocalBranchLifecycle(f.options).resolveForActor(
      rootDropId,
      accountId,
      "retry",
    );
    expect(result.created).toBe(true);
    expect(f.put).not.toHaveBeenCalled();
    expect(f.get.mock.calls.map(([key]) => key)).toEqual([rootDropId]);
  });

  it.each([
    [
      "nullplug response",
      nullplugUiResponseFactKey({
        id: "old",
        primitiveId: "p",
        source: { rootDropId, branchId: "owner" },
      }),
    ],
    [
      "nullplug patch",
      nullplugUiStatePatchFactKey({
        id: "old",
        callId: "c",
        source: { rootDropId, branchId: "owner" },
      }),
    ],
    [
      "nullplug snapshot",
      nullplugUiStateSnapshotKey({
        id: "old",
        callId: "c",
        source: { rootDropId, branchId: "owner" },
      }),
    ],
    ["event sidecar", dropDiffEventMetadataSidecarKey(rootDropId, "owner", 0)],
    [
      "snapshot sidecar",
      dropSnapshotMetadataSidecarKey(rootDropId, "owner", "s", 0),
    ],
    ["resolved heap", dropResolvedHeapKey(rootDropId, "owner", "r", 0)],
    ["branch credential", createDiffAuthCredentialKey(rootDropId, "c", "k")],
  ])(
    "rejects orphan %s using its real persisted key builder",
    async (_name, key) => {
      const f = await fixture();
      f.blobs.seed(key, "malformed orphan payload");
      await expect(f.resolve()).rejects.toMatchObject({
        code: "branch_authority_mismatch",
      });
      expect(f.reserve).not.toHaveBeenCalled();
      expect(f.initialize).not.toHaveBeenCalled();
      expect(f.decrypt).not.toHaveBeenCalled();
      expect(f.put).not.toHaveBeenCalled();
    },
  );

  it.each([
    "nullplug_facts",
    "nullmem_records",
    "resolved_heaps",
    "resolved_nodes",
    "resolved_heap_deltas",
    "resolved_node_refs",
    "resolved_priority_facts",
    "diff_auth_credentials",
  ])(
    "rejects an orphan owner row in the actual migrated %s schema",
    async (table) => {
      const f = await fixture();
      const columns = f.database
        .prepare(`PRAGMA table_info(${table})`)
        .all() as {
        name: string;
        type: string;
        notnull: number;
        dflt_value: unknown;
      }[];
      const required = columns.filter(
        (column) =>
          column.notnull === 1 ||
          ["root_drop_id", "drop_id", "branch_id"].includes(column.name),
      );
      const values = required.map((column) => {
        if (["root_drop_id", "drop_id"].includes(column.name))
          return rootDropId;
        if (column.name === "branch_id") return "owner";
        return /INT|REAL/.test(column.type) ? 0 : "orphan";
      });
      f.database
        .prepare(
          `INSERT INTO ${table} (${required.map((column) => column.name).join(",")}) VALUES (${required.map(() => "?").join(",")})`,
        )
        .run(...values);
      await expect(f.resolve()).rejects.toMatchObject({
        code: "branch_authority_mismatch",
      });
      expect(f.reserve).not.toHaveBeenCalled();
      expect(f.decrypt).not.toHaveBeenCalled();
    },
  );

  it.each(["void_data_records", "void_data_indexes", "void_data_fts"])(
    "rejects orphan generic branch state in %s",
    async (table) => {
      const f = await fixture();
      const scope = { rootDropId, branchId: "owner", snapshotId: 0 };
      const scopeKey = resolveRuntimeDataScopeKey(scope);
      if (table === "void_data_records") {
        f.database
          .prepare(
            "INSERT INTO void_data_records VALUES ('resolved','heaps',?,'r',?,'{}',NULL,1)",
          )
          .run(
            scopeKey,
            JSON.stringify({
              namespace: "resolved",
              collection: "heaps",
              scope,
              id: "r",
            }),
          );
      } else if (table === "void_data_indexes") {
        f.database
          .prepare(
            "INSERT INTO void_data_indexes VALUES ('resolved','heaps',?,'r','kind','exact','x',NULL,NULL,1)",
          )
          .run(scopeKey);
      } else {
        f.database
          .prepare(
            "INSERT INTO void_data_fts VALUES ('orphan','resolved','heaps',?,'r')",
          )
          .run(scopeKey);
      }
      await expect(f.resolve()).rejects.toMatchObject({
        code: "branch_authority_mismatch",
      });
      expect(f.reserve).not.toHaveBeenCalled();
    },
  );

  it("does not ignore a mismatched generic scope key when the stored key retains root identity", async () => {
    const f = await fixture();
    f.database
      .prepare(
        "INSERT INTO void_data_records VALUES ('resolved','heaps','broken','r',?,'{}',NULL,1)",
      )
      .run(JSON.stringify({ scope: { rootDropId, branchId: "owner" } }));
    await expect(f.resolve()).rejects.toMatchObject({
      code: "branch_authority_mismatch",
    });
    expect(f.reserve).not.toHaveBeenCalled();
  });

  it.each(["nullmem_records", "resolved_node_refs", "void_data_indexes"])(
    "fails closed when required absence table %s is unavailable",
    async (table) => {
      const f = await fixture();
      f.database.exec(`DROP TABLE ${table}`);
      await expect(f.resolve()).rejects.toMatchObject({
        code: "state_unavailable",
      });
      expect(f.reserve).not.toHaveBeenCalled();
    },
  );

  it("rejects a nested reservation placement that masks invalid outer generation", async () => {
    const f = await fixture();
    await f.resolve();
    const authority = (await f.backend.readPlacement({ target }))!;
    const forged = {
      ...authority,
      placement: { ...placement, generation: -9 },
      reservation: { ...authority.reservation, placement },
    };
    jest
      .spyOn(f.backend, "readPlacement")
      .mockResolvedValue(forged as BranchAuthorityRecord);
    await expect(f.lifecycle.readPlacement(target)).rejects.toMatchObject({
      code: "state_corrupt",
    });
    await expect(f.resolve()).rejects.toMatchObject({ code: "state_corrupt" });
    expect(f.initialize).toHaveBeenCalledTimes(1);
  });

  it.each([
    "coherent-invalid",
    "version",
    "status",
    "hash",
    "missing-field",
    "unsafe-sequence",
    "empty-head-mismatch",
    "snapshot-order",
  ])("rejects malformed complete head: %s", async (kind) => {
    const f = await fixture();
    await f.resolve();
    const head = await f.backend.readHead({ target, placement });
    if (kind === "coherent-invalid") {
      head.branch.status = "archived";
      head.branch.headSnapshotId = head.version.snapshotId = -3;
      head.branch.headEventSeq = head.version.eventSeq = -5;
      head.version.sourceContentHash =
        "invalid" as typeof head.version.sourceContentHash;
    }
    if (kind === "version") Object.assign(head.branch, { version: 99 });
    if (kind === "status") head.branch.status = "archived";
    if (kind === "hash")
      head.version.sourceContentHash =
        "invalid" as typeof head.version.sourceContentHash;
    if (kind === "missing-field")
      Reflect.deleteProperty(head.branch, "updatedAt");
    if (kind === "unsafe-sequence")
      head.branch.headEventSeq = head.version.eventSeq =
        Number.MAX_SAFE_INTEGER + 1;
    if (kind === "empty-head-mismatch")
      head.branch.headEventSeq = head.version.eventSeq = 0;
    if (kind === "snapshot-order") {
      head.branch.headSnapshotId = head.version.snapshotId = 4;
      head.branch.headEventSeq = head.version.eventSeq = 0;
    }
    jest
      .spyOn(f.backend, "readHead")
      .mockResolvedValue(head as BranchStateHead);
    await expect(f.resolve()).rejects.toMatchObject({ code: "state_corrupt" });
    expect(f.initialize).toHaveBeenCalledTimes(1);
  });

  it("reserves the HEAD revision before capture, opens the verified root and preserves snapshot-zero policy", async () => {
    const f = await fixture();
    f.get.mockRestore();
    const read = f.blobs.get.bind(f.blobs);
    jest.spyOn(f.blobs, "get").mockImplementation(async (key) => {
      if (key === rootDropId)
        expect(await f.backend.readPlacement({ target })).toMatchObject({
          state: "pending",
          reservation: { rootRevision: f.rootRevision },
        });
      return read(key);
    });
    const result = await f.resolve();
    expect(result).toMatchObject({
      created: true,
      branch: {
        ...target,
        mode: "owner",
        ownerAccountId: accountId,
        writerAccountId: accountId,
        writerClientId: "client-a",
        checkpointInterval: 24,
        headSnapshotId: 0,
        headEventSeq: -1,
      },
    });
    const head = await f.backend.readHead({ target, placement });
    // Encryption encodes UTF-8: the original lone surrogate becomes a replacement character.
    expect(
      (
        await f.backend.readContent({
          target,
          placement,
          version: head.version,
        })
      ).content,
    ).toBe(initialContent.replace("\ud800", "\ufffd"));
    expect(await f.lifecycle.requireActivePlacement(target)).toEqual(placement);
    expect(f.initialize).toHaveBeenCalledTimes(1);
    expect(f.reserve.mock.calls[0][0].rootRevision).toBe(f.rootRevision);
    expect(f.put).not.toHaveBeenCalled();
    expect(
      f.database.prepare("SELECT COUNT(*) AS count FROM branches").get(),
    ).toEqual({ count: 0 });
  });

  it("converges concurrent clients of one owner and one clone writer without legacy pointers", async () => {
    const f = await fixture();
    const owners = await Promise.all([
      f.resolve(accountId, "a"),
      f.resolve(accountId, "b"),
    ]);
    expect(owners.filter((r) => r.created)).toHaveLength(1);
    expect(owners[0].branch).toEqual(owners[1].branch);
    const clones = await Promise.all([
      f.resolve("writer", "x"),
      f.resolve("writer", "y"),
    ]);
    expect(clones.filter((r) => r.created)).toHaveLength(1);
    expect(clones[0].branch).toEqual(clones[1].branch);
    expect(clones[0].branch).toMatchObject({
      branchId: "clone_account:writer",
      mode: "clone",
      ownerAccountId: accountId,
      writerAccountId: "writer",
    });
    expect(
      f.database.prepare("SELECT COUNT(*) AS count FROM branch_writers").get(),
    ).toEqual({ count: 0 });
  });

  it.each([null, "", "bad/actor"])(
    "rejects unauthenticated/invalid actor %s before writes or content reads",
    async (actor) => {
      const f = await fixture();
      await expect(f.resolve(actor)).rejects.toMatchObject({
        code: "account_required",
      });
      expect(f.put).not.toHaveBeenCalled();
      expect(f.reserve).not.toHaveBeenCalled();
      expect(f.decrypt).not.toHaveBeenCalled();
      expect(f.get).not.toHaveBeenCalled();
    },
  );

  it("rejects private-root implicit resolution before any reservation or lock write", async () => {
    const f = await fixture();
    f.database.exec(
      "UPDATE account_library_entries SET visibility = 'private'",
    );
    await expect(f.resolve("another-account")).rejects.toMatchObject({
      code: "branch_not_found",
    });
    expect(f.put).not.toHaveBeenCalled();
    expect(f.reserve).not.toHaveBeenCalled();
    expect(f.decrypt).not.toHaveBeenCalled();
  });

  it.each([
    ["DELETE FROM account_library_entries", "account_library_unavailable"],
    [
      "UPDATE account_library_entries SET visibility = 'invalid'",
      "account_library_invalid",
    ],
    [
      "UPDATE account_library_entries SET account_id = 'bad/owner'",
      "account_library_invalid",
    ],
    ["UPDATE account_library_entries SET deleted_at = 2", "branch_not_found"],
  ])("fails closed for projection mutation %s", async (query, code) => {
    const f = await fixture();
    f.database.exec(query);
    await expect(f.resolve()).rejects.toMatchObject({ code });
    expect(f.put).not.toHaveBeenCalled();
    expect(f.reserve).not.toHaveBeenCalled();
  });

  it("rechecks projection before reservation after asynchronous admission reads", async () => {
    const f = await fixture();
    const original = f.backend.readPlacement.bind(f.backend);
    jest
      .spyOn(f.backend, "readPlacement")
      .mockImplementation(async (...args) => {
        const result = await original(...args);
        f.database.exec("UPDATE account_library_entries SET deleted_at = 2");
        return result;
      });
    await expect(f.resolve()).rejects.toMatchObject({
      code: "branch_not_found",
    });
    expect(f.reserve).not.toHaveBeenCalled();
  });

  it.each([
    "__drop_branch__",
    "__drop_writer_branch__",
    "__drop_snapshot__",
    "__drop_checkpoint__",
    "__drop_branch_diff_events__",
    "__drop_branch_diff_event_id_markers_v2__",
    "__drop_publication_receipts__",
  ])(
    "rejects malformed or orphan legacy object in %s rather than importing",
    async (prefix) => {
      const f = await fixture();
      f.blobs.seed(`${prefix}/${rootDropId}/unknown`, "invalid or dangling");
      await expect(f.resolve()).rejects.toMatchObject({
        code: "branch_authority_mismatch",
      });
      expect(f.reserve).not.toHaveBeenCalled();
      expect(f.decrypt).not.toHaveBeenCalled();
    },
  );

  it("rejects a dangling SQL writer pointer even when canonical blob records are absent", async () => {
    const f = await fixture();
    f.database
      .prepare(
        "INSERT INTO branch_writers VALUES (?, 'account:writer', 'missing-branch', 1, 1)",
      )
      .run(rootDropId);
    await expect(f.resolve("writer")).rejects.toMatchObject({
      code: "branch_authority_mismatch",
    });
    expect(f.reserve).not.toHaveBeenCalled();
  });

  it("does not convert failed SQL absence checks into new ownership", async () => {
    const f = await fixture();
    f.database.exec("DROP TABLE branches");
    await expect(f.resolve()).rejects.toMatchObject({
      code: "state_unavailable",
    });
    expect(f.reserve).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { objects: [], truncated: true },
    { objects: null, truncated: false },
  ])("rejects incomplete or malformed legacy listings %#", async (result) => {
    const f = await fixture();
    jest.spyOn(f.blobs, "list").mockResolvedValue(result);
    await expect(f.resolve()).rejects.toMatchObject({
      code: "state_unavailable",
    });
    expect(f.reserve).not.toHaveBeenCalled();
  });

  it("keeps pending placement inaccessible and resumes it through a fresh adapter", async () => {
    const f = await fixture();
    f.initialize.mockRejectedValueOnce(Error("dependency interrupted"));
    await expect(f.resolve()).rejects.toMatchObject({
      code: "state_unavailable",
    });
    const authority = await f.lifecycle.readPlacement(target);
    expect(authority?.state).toBe("pending");
    await expect(
      f.lifecycle.requireActivePlacement(target),
    ).rejects.toMatchObject({ code: "branch_initialization_pending" });
    const retry = await createLocalBranchLifecycle(f.options).resolveForActor(
      rootDropId,
      accountId,
      "second-client",
    );
    expect(retry).toMatchObject({
      created: true,
      branch: {
        writerClientId: "client-a",
        createdAt: authority!.reservation.createdAt,
      },
    });
    expect(f.reserve).toHaveBeenCalledTimes(1);
    expect(f.initialize.mock.calls[0][0]).toEqual(
      f.initialize.mock.calls[1][0],
    );
  });

  it("rechecks authorization before resuming a pending reservation", async () => {
    const f = await fixture();
    f.initialize.mockRejectedValueOnce(Error("interrupted"));
    await expect(f.resolve("writer")).rejects.toMatchObject({
      code: "state_unavailable",
    });
    f.database.exec(
      "UPDATE account_library_entries SET visibility = 'private'",
    );
    f.put.mockClear();
    f.decrypt.mockClear();
    await expect(f.resolve("writer")).rejects.toMatchObject({
      code: "branch_not_found",
    });
    expect(f.initialize).toHaveBeenCalledTimes(1);
    expect(f.put).not.toHaveBeenCalled();
    expect(f.decrypt).not.toHaveBeenCalled();
  });

  it("resumes the winning reservation after losing its response before any source capture", async () => {
    const f = await fixture();
    f.reserve.mockRestore();
    const reserve = f.backend.reserve.bind(f.backend);
    jest.spyOn(f.backend, "reserve").mockImplementationOnce(async (command) => {
      await reserve(command);
      throw Error("reservation response lost");
    });
    await expect(f.resolve()).rejects.toMatchObject({
      code: "state_unavailable",
    });
    expect(f.decrypt).not.toHaveBeenCalled();
    expect(f.get.mock.calls.some(([key]) => key === rootDropId)).toBe(false);
    const pending = (await f.lifecycle.readPlacement(target))!;
    const result = await createLocalBranchLifecycle(f.options).resolveForActor(
      rootDropId,
      accountId,
      "retry-client",
    );
    expect(result.branch.writerClientId).toBe("client-a");
    expect(f.backend.reserve).toHaveBeenCalledTimes(1);
    expect(f.initialize.mock.calls[0][0]).toMatchObject({
      reservationId: pending.reservation.reservationId,
      rootRevision: f.rootRevision,
    });
  });

  it("recovers a root HEAD interruption without reservation or blob writes", async () => {
    const f = await fixture();
    jest
      .spyOn(f.blobs, "head")
      .mockRejectedValueOnce(Error("HEAD interrupted"));
    await expect(f.resolve()).rejects.toMatchObject({
      code: "state_unavailable",
    });
    expect(f.reserve).not.toHaveBeenCalled();
    expect(await f.lifecycle.readPlacement(target)).toBeNull();
    expect((await f.resolve()).created).toBe(true);
    expect(f.put).not.toHaveBeenCalled();
  });

  it("separates a root-body dependency failure from invalid root syntax", async () => {
    const f = await fixture();
    f.get.mockRestore();
    const get = f.blobs.get.bind(f.blobs);
    jest.spyOn(f.blobs, "get").mockImplementation(async (key) => {
      const object = await get(key);
      return key === rootDropId
        ? {
            ...object,
            json: async () => {
              throw Error("body stream unavailable");
            },
          }
        : object;
    });
    await expect(f.resolve()).rejects.toMatchObject({
      code: "state_unavailable",
    });
    expect(f.initialize).not.toHaveBeenCalled();
    expect(f.decrypt).not.toHaveBeenCalled();
    expect((await f.lifecycle.readPlacement(target))?.state).toBe("pending");
  });

  it("preserves an empty decrypted source without a fallback", async () => {
    const f = await fixture();
    const envelope = await createPromotedEnvelope({
      content: "",
      accountId,
      metadata: {},
      providerEncryptionPrivateJwk: encryptionKey,
      providerSigningPrivateJwk: signingKey,
    });
    f.blobs.seed(rootDropId, JSON.stringify(encodeDropEnvelope(envelope)));
    await f.resolve();
    expect(f.initialize.mock.calls[0][0].content).toBe("");
    const head = await f.backend.readHead({ target, placement });
    expect(
      (
        await f.backend.readContent({
          target,
          placement,
          version: head.version,
        })
      ).content,
    ).toBe("");
  });

  it("recovers a lost initialization response without recapture or resetting later edits", async () => {
    const f = await fixture();
    f.initialize.mockRestore();
    const initialize = f.backend.initialize.bind(f.backend);
    jest
      .spyOn(f.backend, "initialize")
      .mockImplementationOnce(async (command) => {
        await initialize(command);
        throw Error("response lost");
      });
    await expect(f.resolve()).rejects.toMatchObject({
      code: "state_unavailable",
    });
    await f.backend.appendBatch({
      target,
      placement,
      events: [
        {
          eventId: "later",
          dropId: rootDropId,
          sourceClientId: "other",
          createdAt: 2,
          seq: 0,
          ops: [{ type: "insert", start: 0, end: 0, text: "later " }],
        },
      ],
    });
    f.get.mockClear();
    f.decrypt.mockClear();
    const resolved = await createLocalBranchLifecycle(
      f.options,
    ).resolveForActor(rootDropId, accountId, "new-client");
    expect(resolved).toMatchObject({
      created: false,
      branch: { headSnapshotId: 1, writerClientId: "client-a" },
    });
    expect(f.get.mock.calls.some(([key]) => key === rootDropId)).toBe(false);
    expect(f.decrypt).not.toHaveBeenCalled();
    expect(f.backend.initialize).toHaveBeenCalledTimes(1);
  });

  it("pins a pending reservation to its original source revision", async () => {
    const f = await fixture();
    f.initialize.mockRejectedValueOnce(Error("interrupted"));
    await expect(f.resolve()).rejects.toMatchObject({
      code: "state_unavailable",
    });
    f.blobs.seed(rootDropId, JSON.stringify(encodeDropEnvelope(f.envelope)));
    await expect(f.resolve()).rejects.toMatchObject({
      code: "branch_initialization_source_changed",
    });
    expect(f.reserve).toHaveBeenCalledTimes(1);
    expect(f.initialize).toHaveBeenCalledTimes(1);
  });

  it("rechecks authorization before activating pending state after source capture", async () => {
    const f = await fixture();
    f.get.mockRestore();
    const read = f.blobs.get.bind(f.blobs);
    jest.spyOn(f.blobs, "get").mockImplementation(async (key) => {
      const result = await read(key);
      if (key === rootDropId)
        f.database.exec("UPDATE account_library_entries SET deleted_at = 2");
      return result;
    });
    await expect(f.resolve()).rejects.toMatchObject({
      code: "branch_not_found",
    });
    expect(f.initialize).not.toHaveBeenCalled();
    expect((await f.lifecycle.readPlacement(target))?.state).toBe("pending");
  });

  it.each([
    "owner",
    "visibility",
    "publication",
    "plaintext",
    "corrupt",
    "recipient-only",
    "ciphertext",
  ])(
    "rejects unsafe root source %s without returning content",
    async (kind) => {
      const f = await fixture();
      if (kind === "owner") f.envelope.accountId = "different-owner";
      if (kind === "visibility") f.envelope.visibility = "private";
      if (kind === "publication")
        f.envelope.metadata.ownerPublication = {
          rootDropId,
          branchId: "owner",
          snapshotId: 2,
        };
      if (kind === "recipient-only") {
        f.envelope.unlockPolicy = "vault-only";
        delete f.envelope.providerEscrow;
      }
      if (kind === "ciphertext") f.envelope.cipher.ciphertext = "invalid";
      const body =
        kind === "plaintext"
          ? JSON.stringify({
              content: "secret",
              metadata: { ownerAccountId: accountId },
            })
          : kind === "corrupt"
            ? "invalid"
            : JSON.stringify(encodeDropEnvelope(f.envelope));
      f.blobs.seed(rootDropId, body);
      await expect(f.resolve()).rejects.toMatchObject({ status: 409 });
      expect(f.initialize).not.toHaveBeenCalled();
      if (kind !== "ciphertext") expect(f.decrypt).not.toHaveBeenCalled();
    },
  );

  it("requires crypto material without exposing its value in the error", async () => {
    const f = await fixture();
    await expect(
      createLocalBranchLifecycle({
        ...f.options,
        providerPrivateKey: undefined,
      }).resolveForActor(rootDropId, accountId, null),
    ).rejects.toMatchObject({
      code: "branch_initialization_crypto_unavailable",
    });
    expect(f.initialize).not.toHaveBeenCalled();
  });

  it("requires eligible scope on both resolution and placement reads", async () => {
    const f = await fixture();
    const local = createLocalBranchLifecycle({
      ...f.options,
      isEligibleRoot: () => false,
    });
    await expect(
      local.resolveForActor(rootDropId, accountId, null),
    ).rejects.toMatchObject({ code: "branch_authority_mismatch" });
    await expect(local.requireActivePlacement(target)).rejects.toMatchObject({
      code: "branch_authority_mismatch",
    });
    await expect(local.readPlacement(target)).rejects.toMatchObject({
      code: "branch_authority_mismatch",
    });
    expect(f.put).not.toHaveBeenCalled();
  });

  it("rejects forged owner placement and does not authorize an arbitrary branch ID", async () => {
    const f = await fixture();
    await f.resolve();
    const authority = (await f.backend.readPlacement({ target }))!;
    authority.reservation.identity.writerAccountId = "other-account";
    jest.spyOn(f.backend, "readPlacement").mockResolvedValue(authority);
    await expect(
      f.lifecycle.requireActivePlacement(target),
    ).rejects.toMatchObject({ code: "state_corrupt" });
    await expect(
      f.lifecycle.readPlacement({ ...target, branchId: "wrong" }),
    ).rejects.toMatchObject({ code: "state_corrupt" });
  });

  it("captures target inputs before async reads and does not expose mutable placement state", async () => {
    const f = await fixture();
    await f.resolve();
    const mutable: BranchStateTarget = { ...target };
    const pending = f.lifecycle.readPlacement(mutable);
    mutable.branchId = "different";
    const authority = (await pending)!;
    authority.placement.generation = 100;
    expect(await f.lifecycle.requireActivePlacement(target)).toEqual(placement);
  });

  it("propagates backend unavailability without reading a root or consulting legacy storage", async () => {
    const f = await fixture();
    jest
      .spyOn(f.backend, "readPlacement")
      .mockRejectedValue(Error("storage unavailable"));
    await expect(f.resolve()).rejects.toMatchObject({
      code: "state_unavailable",
    });
    expect(f.blobs.listCalls).toHaveLength(0);
    expect(f.decrypt).not.toHaveBeenCalled();
    expect(f.reserve).not.toHaveBeenCalled();
  });

  it("does not treat a missing placement as active", async () => {
    const f = await fixture();
    expect(await f.lifecycle.readPlacement(target)).toBeNull();
    await expect(
      f.lifecycle.requireActivePlacement(target),
    ).rejects.toMatchObject({ code: "branch_not_found" });
    expect(f.reserve).not.toHaveBeenCalled();
  });

  it("checks current owner against a previously reserved identity", async () => {
    const f = await fixture();
    f.initialize.mockRejectedValueOnce(Error("interrupted"));
    await expect(f.resolve()).rejects.toMatchObject({
      code: "state_unavailable",
    });
    f.database.exec(
      "UPDATE account_library_entries SET account_id = 'new-owner'",
    );
    await expect(f.resolve("new-owner")).rejects.toMatchObject({
      code: "branch_initialization_conflict",
    });
    expect(f.initialize).toHaveBeenCalledTimes(1);
  });

  it("requires a readable, matching source object revision", async () => {
    const f = await fixture();
    await f.blobs.delete(rootDropId);
    await expect(
      readRootInitializationSource({
        blobs: f.blobs,
        providerPrivateKey: encryptionKey,
        root: { rootDropId, ownerAccountId: accountId, visibility: "unlisted" },
        expectedRevision: f.rootRevision,
      }),
    ).rejects.toMatchObject({ code: "drop_not_found" });
    expect(f.decrypt).not.toHaveBeenCalled();
  });
});

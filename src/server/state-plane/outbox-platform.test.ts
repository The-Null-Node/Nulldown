import { describe, expect, test } from "@jest/globals";
import {
  D1OutboxProjection,
  R2OutboxArchive,
} from "../../../packages/nulldown-state-plane/src/outbox-storage";
import { hashNulldownSourceContent } from "../../../shared/drop/resolved/hash";
import {
  consumeOutboxBatch,
  deliverClaimedOutbox,
  outboxArchiveKey,
  outboxJobRef,
  materializeClaimedOutbox,
  StaleOutboxClaimError,
  sealOutboxArtifact,
  verifySealedOutboxArtifact,
  type ClaimedOutboxMaterial,
  type OutboxPlatformDependencies,
  type OutboxReferenceMessage,
} from "../../../packages/nulldown-state-plane/src/outbox-platform";

const material: ClaimedOutboxMaterial = {
  item: {
    target: { rootDropId: "root", branchId: "branch" },
    placement: { routingVersion: 1, generation: 3 },
    outboxId: "outbox-1",
    leaseToken: "lease-token",
  },
  claimed: {} as ClaimedOutboxMaterial["claimed"],
  identity: { rootDropId: "root", branchId: "branch", generation: 3 },
  artifact: { version: 1, snapshot: { exact: true }, events: [{ seq: 4 }] },
  projection: {
    domain: "document",
    version: 4,
    sourceHash: "sha256:source",
    metadata: { kind: "snapshot" },
  },
};
const message: OutboxReferenceMessage = {
  version: 1,
  target: { rootDropId: "root", branchId: "branch" },
  placement: { routingVersion: 1, generation: 3 },
  item: material.item,
  leaseId: "lease",
};
const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

describe("outbox platform delivery", () => {
  test("seals exact material with AES-256-GCM and identity-bound associated data", async () => {
    const sealed = await sealOutboxArtifact(material, key, "staging-key-1");
    expect(sealed.format).toBe("nulldown.outbox.archive.v1");
    expect(sealed.identityHash).toMatch(/^sha256:/);
    expect(JSON.stringify(sealed)).not.toContain('"root"');
    expect(sealed.iv).toHaveLength(16);
    expect(sealed.ciphertext).not.toContain("snapshot");
    expect(sealed.artifactHash).toMatch(/^sha256:/);
    await expect(
      verifySealedOutboxArtifact(sealed, material, key, "staging-key-1"),
    ).resolves.toBe(true);
    await expect(
      verifySealedOutboxArtifact(
        { ...sealed, ciphertext: `${sealed.ciphertext.slice(0, -2)}AA` },
        material,
        key,
        "staging-key-1",
      ),
    ).resolves.toBe(false);
    await expect(
      sealOutboxArtifact(material, btoa("short"), "key-1"),
    ).rejects.toThrow("invalid_archive_key");
  });

  test("does not acknowledge until archive and D1 projection are durable", async () => {
    const order: string[] = [];
    const deps = dependencies({
      archive: {
        putIfAbsent: async () => {
          order.push("archive");
          return true;
        },
        readExisting: async () => null,
      },
      projection: {
        apply: async () => {
          order.push("projection");
          return "applied";
        },
      },
      consumer: {
        readClaimed: async () => material,
        acknowledge: async () => {
          order.push("ack");
          return true;
        },
        retry: async () => {
          order.push("retry");
        },
      },
    });
    await expect(deliverClaimedOutbox(message, deps)).resolves.toBe(
      "acknowledged",
    );
    expect(order).toEqual(["archive", "projection", "ack"]);
  });

  test("retries on projection failure without acknowledging after archive commit", async () => {
    const calls: string[] = [];
    const deps = dependencies({
      archive: {
        putIfAbsent: async () => {
          calls.push("archive");
          return true;
        },
        readExisting: async () => null,
      },
      projection: {
        apply: async () => {
          calls.push("project");
          throw new Error("d1 unavailable");
        },
      },
      consumer: {
        readClaimed: async () => material,
        acknowledge: async () => {
          calls.push("ack");
          return true;
        },
        retry: async (_message, reason) => {
          calls.push(`retry:${reason}`);
        },
      },
    });
    await expect(deliverClaimedOutbox(message, deps)).resolves.toBe("retry");
    expect(calls).toEqual(["archive", "project", "retry:projection_failed"]);
  });

  test("rejects stale lease material and never acknowledges it", async () => {
    const calls: string[] = [];
    const deps = dependencies({
      consumer: {
        readClaimed: async () => ({
          ...material,
          item: { ...material.item, leaseToken: "old-token" },
        }),
        acknowledge: async () => {
          calls.push("ack");
          return true;
        },
        retry: async (_message, reason) => {
          calls.push(`retry:${reason}`);
        },
      },
    });
    await expect(deliverClaimedOutbox(message, deps)).resolves.toBe("retry");
    expect(calls).toEqual(["retry:invalid_material"]);
  });

  test("discards expired queue references without retrying the stale lease", async () => {
    const calls: string[] = [];
    const deps = dependencies({
      consumer: {
        readClaimed: async () => {
          throw new StaleOutboxClaimError();
        },
        acknowledge: async () => {
          calls.push("ack");
          return false;
        },
        retry: async () => {
          calls.push("retry");
        },
      },
    });
    const messages = [
      {
        body: message,
        ack: () => calls.push("queue_ack"),
        retry: () => calls.push("queue_retry"),
      },
    ];
    await consumeOutboxBatch(messages, deps);
    expect(calls).toEqual(["queue_ack"]);
  });

  test("rejects extra queue fields before the consumer or router can see document data", async () => {
    const calls: string[] = [];
    const deps = dependencies({
      consumer: {
        readClaimed: async () => {
          calls.push("read");
          return material;
        },
        acknowledge: async () => true,
        retry: async () => undefined,
      },
    });
    await consumeOutboxBatch(
      [
        {
          body: { ...message, content: "private" } as OutboxReferenceMessage,
          ack: () => calls.push("ack"),
          retry: () => calls.push("retry"),
        },
      ],
      deps,
    );
    expect(calls).toEqual(["ack"]);
  });

  test("stores each D1 job receipt while partitioning monotonic cursors by domain", async () => {
    const database = new MemoryProjectionDatabase();
    const projection = new D1OutboxProjection(
      database as unknown as D1Database,
    );
    const base = {
      jobRef: `op1_${"a".repeat(43)}`,
      keyId: "key-1",
      rootDropId: "root",
      branchId: "branch",
      generation: 2,
      version: 8,
      sourceHash: "sha256:s",
      archiveKey: "v1/a",
      artifactHash: "sha256:a",
      metadata: {},
    };
    await expect(
      projection.apply({ ...base, domain: "document" }),
    ).resolves.toBe("applied");
    await expect(
      projection.apply({
        ...base,
        jobRef: `op1_${"b".repeat(43)}`,
        domain: "runtime_fact",
      }),
    ).resolves.toBe("applied");
    await expect(
      projection.apply({ ...base, domain: "document" }),
    ).resolves.toBe("duplicate");
    await expect(
      projection.apply({
        ...base,
        jobRef: `op1_${"c".repeat(43)}`,
        domain: "document",
        version: 7,
        artifactHash: "sha256:older",
      }),
    ).resolves.toBe("applied");
    await expect(
      projection.apply({
        ...base,
        jobRef: `op1_${"d".repeat(43)}`,
        domain: "document",
        artifactHash: "sha256:same-version-distinct-job",
      }),
    ).resolves.toBe("applied");
    await expect(
      projection.apply({
        ...base,
        keyId: "key-2",
        archiveKey: "v1/a/key-2",
        domain: "document",
      }),
    ).resolves.toBe("applied");
    expect(database.receipts.size).toBe(5);
    expect(database.cursors.size).toBe(2);
    expect(
      database.cursors.get("root\u0000branch\u0000document")?.version,
    ).toBe(8);
    expect(
      database.cursors.get("root\u0000branch\u0000runtime_fact")?.version,
    ).toBe(8);
  });

  test("same job/key concurrent identity conflicts cannot advance the cursor from the losing tuple", async () => {
    const database = new MemoryProjectionDatabase();
    const projection = new D1OutboxProjection(
      database as unknown as D1Database,
    );
    const base = {
      jobRef: `op1_${"e".repeat(43)}`,
      keyId: "key-1",
      domain: "document" as const,
      rootDropId: "root",
      branchId: "branch",
      generation: 9,
      version: 12,
      sourceHash: "sha256:source",
      metadata: {},
    };
    const left = {
      ...base,
      artifactHash: "sha256:left",
      archiveKey: "v1/left",
    };
    const right = {
      ...base,
      artifactHash: "sha256:right",
      archiveKey: "v1/right",
    };
    const results = await Promise.allSettled([
      projection.apply(left),
      projection.apply(right),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    const receipt = database.receipts.get(`${base.jobRef}\u0000${base.keyId}`)!;
    const cursor = database.cursors.get("root\u0000branch\u0000document")!;
    expect(cursor.artifact_hash).toBe(receipt.artifact_hash);
    expect(cursor.archive_key).toBe(receipt.archive_key);
  });

  test("R2 archive uses atomic create-only writes and verifies existing metadata/body", async () => {
    const bucket = new MemoryArchiveBucket();
    const archive = new R2OutboxArchive(bucket as unknown as R2Bucket);
    const metadata = {
      format: "nulldown.outbox.archive.v1",
      artifactHash: "sha256:test",
    };
    await expect(
      archive.putIfAbsent("v1/op1_test", "sealed", metadata),
    ).resolves.toBe(true);
    await expect(
      archive.putIfAbsent("v1/op1_test", "replacement", metadata),
    ).resolves.toBe(false);
    await expect(archive.readExisting("v1/op1_test")).resolves.toEqual({
      metadata,
      body: "sealed",
    });
    expect(bucket.puts).toBe(2);
    expect(bucket.conditions).toEqual([
      { etagDoesNotMatch: "*" },
      { etagDoesNotMatch: "*" },
    ]);
  });

  test("materializes and validates exact snapshot identity while paging ranges above 200 events", async () => {
    const sourceContentHash = await hashNulldownSourceContent("content");
    const version = {
      snapshotId: 1,
      eventSeq: 200,
      sourceContentHash,
    } as const;
    const target = { rootDropId: "root", branchId: "branch" };
    const placement = { routingVersion: 1, generation: 3 };
    const eventIds = Array.from(
      { length: 201 },
      (_, index) => `event-${index}`,
    );
    const snapshot = {
      version: 1,
      snapshotId: 1,
      rootDropId: "root",
      branchId: "branch",
      parentSnapshotId: 0,
      seq: 1,
      eventIds,
      checkpointed: true,
      patchStartSeq: 0,
      patchEndSeq: 200,
      textLength: 7,
      sourceContentHash: version.sourceContentHash,
    };
    const outbox = {
      id: "outbox-1",
      kind: "branch.commit.v1",
      receipt: {
        target,
        placement,
        eventId: "event-200",
        payloadHash: "sha256:p",
        version,
      },
    };
    const claimed = {
      target,
      placement,
      outbox,
      status: "claimed",
      attempt: 1,
      leaseUntil: 10_000,
    } as ClaimedOutboxMaterial["claimed"];
    const pages: Array<[number, number]> = [];
    const result = await materializeClaimedOutbox(claimed, material.item, {
      readContent: async (query) => ({ ...query, content: "content" }),
      readSnapshot: async (query) => ({ ...query, version, snapshot }),
      readEvents: async (query) => {
        pages.push([query.startSeq, query.endSeq]);
        return Array.from(
          { length: query.endSeq - query.startSeq + 1 },
          (_, offset) => ({
            seq: query.startSeq + offset,
            eventId: `event-${query.startSeq + offset}`,
          }),
        ) as never[];
      },
    });
    expect(pages).toEqual([
      [0, 199],
      [200, 200],
    ]);
    expect((result.artifact as { events: unknown[] }).events).toHaveLength(201);
    expect(result.projection.domain).toBe("document");
    await expect(
      materializeClaimedOutbox(claimed, material.item, {
        readContent: async (query) => ({
          ...query,
          target: { rootDropId: "other", branchId: "branch" },
          content: "content",
        }),
        readSnapshot: async (query) => ({ ...query, version, snapshot }),
        readEvents: async () => [],
      }),
    ).rejects.toThrow("content_identity_mismatch");
  });

  test("redelivers safely when durable outputs succeed but acknowledgement transiently fails", async () => {
    let archived: string | undefined;
    let storedHash: string | undefined;
    let failAck = true;
    const calls: string[] = [];
    const deps = dependencies({
      archive: {
        putIfAbsent: async (_path, body) => {
          if (archived) return false;
          archived = body;
          return true;
        },
        readExisting: async () =>
          archived
            ? {
                metadata: {
                  format: "nulldown.outbox.archive.v1",
                  keyId: "test-key",
                  artifactHash: storedHash!,
                  generation: "3",
                  version: "4",
                  sourceHash: "sha256:source",
                },
                body: archived,
              }
            : null,
      },
      projection: {
        apply: async ({ artifactHash }) => {
          storedHash = artifactHash;
          calls.push("project");
          return calls.length === 1 ? "applied" : "duplicate";
        },
      },
      consumer: {
        readClaimed: async () => material,
        acknowledge: async () => {
          calls.push("ack");
          if (failAck) {
            failAck = false;
            throw new Error("dependency unavailable");
          }
          return true;
        },
        retry: async () => {
          calls.push("retry");
        },
      },
    });
    await expect(deliverClaimedOutbox(message, deps)).resolves.toBe("retry");
    await expect(deliverClaimedOutbox(message, deps)).resolves.toBe(
      "acknowledged",
    );
    expect(calls).toEqual(["project", "ack", "retry", "project", "ack"]);
  });

  test("uses a stable non-content archive path and isolates queue message failures", async () => {
    await expect(outboxJobRef(material.item)).resolves.toMatch(
      /^op1_[A-Za-z0-9_-]{43}$/,
    );
    await expect(outboxArchiveKey(material, "test-key")).resolves.toMatch(
      /^v1\/op1_/,
    );
    const retried: number[] = [];
    const deps = dependencies({
      consumer: {
        readClaimed: async () => {
          throw new Error("private payload must not escape");
        },
        acknowledge: async () => false,
        retry: async () => undefined,
      },
    });
    await consumeOutboxBatch(
      [
        {
          body: message,
          ack: () => {
            throw new Error("must not ack");
          },
          retry: () => {
            retried.push(0);
          },
        },
        {
          body: message,
          ack: () => {
            throw new Error("must not ack");
          },
          retry: () => {
            retried.push(1);
          },
        },
      ],
      deps,
    );
    expect(retried).toEqual([0, 1]);
  });
});

function dependencies(
  overrides: Partial<OutboxPlatformDependencies> = {},
): OutboxPlatformDependencies {
  return {
    enabled: true,
    archiveKey: key,
    archiveKeyId: "test-key",
    archive: { putIfAbsent: async () => true, readExisting: async () => null },
    projection: { apply: async () => "applied" },
    consumer: {
      readClaimed: async () => material,
      acknowledge: async () => true,
      retry: async () => undefined,
    },
    ...overrides,
  };
}

class MemoryProjectionDatabase {
  receipts = new Map<string, Record<string, unknown>>();
  cursors = new Map<string, Record<string, unknown>>();

  prepare(sql: string) {
    let values: unknown[] = [];
    const statement = {
      bind: (...bindings: unknown[]) => {
        values = bindings;
        return statement;
      },
      first: async <T>() => {
        if (sql.includes("FROM state_plane_outbox_delivery_receipts"))
          return (
            (this.receipts.get(`${values[0]}\u0000${values[1]}`) as T) ?? null
          );
        return null;
      },
      run: async () => {
        this.apply(sql, values);
        return { success: true };
      },
    };
    return statement;
  }

  async batch(statements: { run(): Promise<unknown> }[]) {
    for (const statement of statements) await statement.run();
    return [];
  }

  private apply(sql: string, v: unknown[]) {
    if (sql.includes("INSERT INTO state_plane_outbox_delivery_receipts")) {
      const [
        job_ref,
        key_id,
        root_drop_id,
        branch_id,
        generation,
        domain,
        version,
        source_hash,
        artifact_hash,
        archive_key,
        metadata_json,
        delivered_at,
      ] = v;
      const key = `${job_ref}\u0000${key_id}`;
      if (!this.receipts.has(key))
        this.receipts.set(key, {
          root_drop_id,
          branch_id,
          generation,
          domain,
          version,
          source_hash,
          artifact_hash,
          archive_key,
          metadata_json,
          delivered_at,
        });
      return;
    }
    if (sql.includes("INSERT INTO state_plane_outbox_projection_cursor")) {
      const [
        updated_at,
        job_ref,
        key_id,
        root_drop_id,
        branch_id,
        generation,
        domain,
        version,
        source_hash,
        artifact_hash,
        archive_key,
        metadata_json,
      ] = v;
      const receipt = this.receipts.get(`${job_ref}\u0000${key_id}`);
      if (
        !receipt ||
        [
          receipt.root_drop_id,
          receipt.branch_id,
          receipt.generation,
          receipt.domain,
          receipt.version,
          receipt.source_hash,
          receipt.artifact_hash,
          receipt.archive_key,
          receipt.metadata_json,
        ].some(
          (value, index) =>
            value !==
            [
              root_drop_id,
              branch_id,
              generation,
              domain,
              version,
              source_hash,
              artifact_hash,
              archive_key,
              metadata_json,
            ][index],
        )
      )
        return;
      const key = `${root_drop_id}\u0000${branch_id}\u0000${domain}`;
      const old = this.cursors.get(key);
      const newer =
        !old ||
        Number(generation) > Number(old.generation) ||
        (generation === old.generation &&
          (Number(version) > Number(old.version) ||
            (version === old.version &&
              (String(job_ref) > String(old.job_ref) ||
                (job_ref === old.job_ref &&
                  String(key_id) > String(old.key_id))))));
      if (newer)
        this.cursors.set(key, {
          root_drop_id,
          branch_id,
          domain,
          generation,
          version,
          job_ref,
          key_id,
          source_hash,
          artifact_hash,
          archive_key,
          metadata_json: receipt.metadata_json,
          updated_at,
        });
    }
  }
}

class MemoryArchiveBucket {
  objects = new Map<
    string,
    { body: string; customMetadata: Record<string, string> }
  >();
  conditions: unknown[] = [];
  puts = 0;

  async put(
    key: string,
    body: string,
    options?: { onlyIf?: unknown; customMetadata?: Record<string, string> },
  ) {
    this.puts++;
    this.conditions.push(options?.onlyIf);
    if (this.objects.has(key)) return null;
    this.objects.set(key, {
      body,
      customMetadata: options?.customMetadata ?? {},
    });
    return {};
  }

  async head(key: string) {
    const object = this.objects.get(key);
    return object ? { customMetadata: object.customMetadata } : null;
  }

  async get(key: string) {
    const object = this.objects.get(key);
    return object ? { text: async () => object.body } : null;
  }
}

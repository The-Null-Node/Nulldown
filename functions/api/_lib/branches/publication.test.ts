import { jest } from "@jest/globals";
import { MemoryR2Bucket } from "../diffs/testing/storage-fixture";
import { resolveBranchForActor } from "./lifecycle";
import { appendEventsToBranch } from "../nulledit/service";
import { publishOwnerSnapshot } from "./publication";
import { readBranchContent } from "./content/replay";
import { storeDrop } from "../drops/services/store-drop";
import { createRequestLogger } from "../core/logging/logger";
import type { SqlMetadataStore } from "../../../../src/server/ports";
import { createPromotedEnvelope } from "../crypto/envelopes/promotion";
import { decryptProviderEscrowEnvelope } from "../crypto/envelopes/provider-escrow";
import {
  encodeDropEnvelope,
  decodeDropEnvelope,
} from "../../../../shared/drop/codecs/envelope-v1";

const rootId = "publication-root01";
const account = "publication-owner";
const setup = async () => {
  const bucket = new MemoryR2Bucket();
  bucket.seed(
    rootId,
    JSON.stringify({ content: "base", metadata: { ownerAccountId: account } }),
  );
  const { branch } = await resolveBranchForActor(
    bucket,
    rootId,
    account,
    "writer",
  );
  const append = (text: string, eventId: string) =>
    appendEventsToBranch(bucket, branch, [
      {
        eventId,
        dropId: rootId,
        seq: 0,
        createdAt: 1,
        sourceClientId: "writer",
        ops: [{ type: "insert", start: 0, end: 0, text }],
      },
    ]);
  await append("one ", "one");
  const db = {
    prepare(sql: string) {
      return {
        bind() {
          return this;
        },
        async first() {
          return sql.includes("FROM account_library_entries")
            ? {
                drop_id: rootId,
                account_id: account,
                deleted_at: null,
                visibility: "unlisted",
                created_at: 1,
                updated_at: 1,
              }
            : null;
        },
        async run() {
          return { success: true };
        },
        async all() {
          return { results: [] };
        },
      };
    },
  } as unknown as SqlMetadataStore;
  const env = {
    R2_BUCKET: bucket,
    DB: db,
    PUBLIC_BASE_URL: "https://nulldown.test",
    ALLOW_INSECURE_ACCOUNT_HEADER: "1",
  };
  const initialRevision = (await bucket.head(rootId)).etag as string;
  const publish = (
    input = {
      expectedSnapshotId: 1,
      expectedRevision: initialRevision,
      idempotencyKey: "publish-1",
    },
    actor = account,
    branchId = "owner",
  ) =>
    publishOwnerSnapshot(
      env,
      { rootId, branchId },
      new Request("https://nulldown.test/api/branches/root/owner/publish", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-nulldown-account-id": actor,
        },
        body: JSON.stringify(input),
      }),
    );
  return { bucket, branch, db, env, append, initialRevision, publish };
};

describe("same-root owner publication", () => {
  beforeEach(() => {
    jest.spyOn(console, "info").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it.each([account, "reader"])(
    "does not bootstrap %s from an old root after losing its root lease",
    async (actor) => {
      const bucket = new MemoryR2Bucket();
      bucket.seed(
        rootId,
        JSON.stringify({
          content: "old",
          metadata: { ownerAccountId: account },
        }),
      );
      const get = bucket.get.bind(bucket);
      jest.spyOn(bucket, "get").mockImplementation(async (key) => {
        const object = await get(key);
        if (key === rootId) {
          bucket.seed(
            `__drop_root_lock__/${rootId}.json`,
            JSON.stringify({ token: "another-writer", createdAt: Date.now() }),
          );
        }
        return object;
      });
      await expect(
        resolveBranchForActor(bucket, rootId, actor, "writer"),
      ).rejects.toMatchObject({ code: "root_mutation_lock_lost" });
      expect(
        (await bucket.list({ prefix: "__drop_branch__/" })).objects,
      ).toHaveLength(0);
    },
  );

  it("publishes a sealed private root without changing recipients or visibility", async () => {
    const { bucket, env, publish } = await setup();
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
    const encryptionKey = JSON.stringify(
      await crypto.subtle.exportKey(
        "jwk",
        (encryption as CryptoKeyPair).privateKey,
      ),
    );
    const signingKey = JSON.stringify(
      await crypto.subtle.exportKey(
        "jwk",
        (signing as CryptoKeyPair).privateKey,
      ),
    );
    Object.assign(env, {
      PROVIDER_ENCRYPTION_PRIVATE_JWK: encryptionKey,
      PROVIDER_SIGNING_PRIVATE_JWK: signingKey,
    });
    const original = await createPromotedEnvelope({
      content: "base",
      accountId: account,
      metadata: {},
      providerEncryptionPrivateJwk: encryptionKey,
      providerSigningPrivateJwk: signingKey,
    });
    original.visibility = "private";
    bucket.seed(rootId, JSON.stringify(encodeDropEnvelope(original)));
    const result = await publish({
      expectedSnapshotId: 1,
      expectedRevision: (await bucket.head(rootId)).etag,
      idempotencyKey: "sealed-publication",
    });
    expect(result.status).toBe(200);
    const updated = decodeDropEnvelope(
      await (await bucket.get(rootId)).json(),
    )!;
    expect(updated.visibility).toBe("private");
    expect(updated.keyEnvelope).toEqual(original.keyEnvelope);
    expect(
      await decryptProviderEscrowEnvelope(updated, encryptionKey),
    ).toMatchObject({ content: "one base" });
  });

  it("keeps publication successful if telemetry emission throws", async () => {
    const { publish } = await setup();
    jest.spyOn(console, "info").mockImplementation(() => {
      throw new Error("collector unavailable");
    });
    expect((await publish()).status).toBe(200);
  });

  it("updates the same root, preserves owner history, and seeds only new clones from published content", async () => {
    const { bucket, publish } = await setup();
    const oldClone = await resolveBranchForActor(
      bucket,
      rootId,
      "old-reader",
      "a",
    );
    const result = await publish();
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      dropId: rootId,
      rootDropId: rootId,
      outcome: "root-published",
      snapshotId: 1,
    });
    expect(await (await bucket.get(rootId)).json()).toMatchObject({
      content: "one base",
      metadata: { ownerPublication: { snapshotId: 1 } },
    });
    const reopened = await resolveBranchForActor(
      bucket,
      rootId,
      account,
      "other-agent",
    );
    expect(reopened.created).toBe(false);
    expect(reopened.branch.headSnapshotId).toBe(1);
    const newClone = await resolveBranchForActor(
      bucket,
      rootId,
      "new-reader",
      "b",
    );
    expect(
      await readBranchContent(bucket, rootId, newClone.branch.branchId, 0),
    ).toBe("one base");
    expect(
      await readBranchContent(bucket, rootId, oldClone.branch.branchId, 0),
    ).toBe("base");
  });

  it("replays a completed receipt after a newer publication without rolling back the root", async () => {
    const { bucket, publish, append } = await setup();
    const first = (await (await publish()).json()) as { revision: string };
    await append("two ", "two");
    expect(
      (
        await publish({
          expectedSnapshotId: 2,
          expectedRevision: first.revision,
          idempotencyKey: "publish-2",
        })
      ).status,
    ).toBe(200);
    expect(await (await publish()).json()).toEqual(first);
    expect(await (await bucket.get(rootId)).json()).toMatchObject({
      content: "two one base",
    });
  });

  it("recovers after the root write succeeds but its response is lost", async () => {
    const { bucket, publish, append } = await setup();
    const put = bucket.put.bind(bucket);
    let lose = true;
    jest.spyOn(bucket, "put").mockImplementation(async (...args) => {
      const result = await put(...args);
      if (args[0] === rootId && lose) {
        lose = false;
        throw new Error("response lost");
      }
      return result;
    });
    expect((await publish()).status).toBe(503);
    await append("later ", "later");
    const retry = await publish();
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ snapshotId: 1 });
    expect(await (await bucket.get(rootId)).json()).toMatchObject({
      content: "one base",
    });
  });

  it("does not resume a pending publication over a newer root", async () => {
    const { bucket, publish, append } = await setup();
    const put = bucket.put.bind(bucket);
    let lose = true;
    jest.spyOn(bucket, "put").mockImplementation(async (...args) => {
      const result = await put(...args);
      if (args[0] === rootId && lose) {
        lose = false;
        throw new Error("lost");
      }
      return result;
    });
    expect((await publish()).status).toBe(503);
    await append("two ", "two");
    const nextRevision = (await bucket.head(rootId)).etag;
    expect(
      (
        await publish({
          expectedSnapshotId: 2,
          expectedRevision: nextRevision,
          idempotencyKey: "publish-2",
        })
      ).status,
    ).toBe(200);
    const retry = await publish();
    expect(retry.status).toBe(409);
    expect(await retry.json()).toMatchObject({
      code: "publication_revision_mismatch",
    });
    expect(await (await bucket.get(rootId)).json()).toMatchObject({
      content: "two one base",
    });
  });

  it("fences concurrent publications and rejects stale heads, revisions and changed retry identities", async () => {
    const { publish, initialRevision } = await setup();
    const responses = await Promise.all([
      publish(),
      publish({
        expectedSnapshotId: 1,
        expectedRevision: initialRevision,
        idempotencyKey: "competing",
      }),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(
      (
        await publish({
          expectedSnapshotId: 0,
          expectedRevision: initialRevision,
          idempotencyKey: "stale",
        })
      ).status,
    ).toBe(409);
    const winner = responses[0].status === 200 ? "publish-1" : "competing";
    expect(
      await (
        await publish({
          expectedSnapshotId: 2,
          expectedRevision: initialRevision,
          idempotencyKey: winner,
        })
      ).json(),
    ).toMatchObject({ code: "publication_idempotency_mismatch" });
  });

  it("rejects non-owners and clone targets without changing the root", async () => {
    const { publish, bucket, initialRevision } = await setup();
    expect((await publish(undefined, "other")).status).toBe(403);
    expect(
      (await publish(undefined, account, "clone_account:other")).status,
    ).toBe(403);
    expect((await bucket.head(rootId)).etag).toBe(initialRevision);
  });

  it("rejects direct root replacement after owner history exists", async () => {
    const { bucket, db, initialRevision } = await setup();
    const request = new Request("https://nulldown.test/api/store", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: rootId,
        upsert: true,
        expectedRevision: initialRevision,
        content: "replacement",
      }),
    });
    const result = await storeDrop({
      request,
      env: { blobs: bucket, sql: db },
      trustedPlaintextAccountId: account,
      logger: createRequestLogger({ request, route: "/api/store" }),
    });
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({
      code: "owner_branch_publication_required",
    });
    expect((await bucket.head(rootId)).etag).toBe(initialRevision);
  });

  it("detects pre-existing root/history divergence instead of resurrecting branch text", async () => {
    const { bucket } = await setup();
    bucket.seed(
      rootId,
      JSON.stringify({
        content: "newer external root",
        metadata: { ownerAccountId: account },
      }),
    );
    await expect(
      resolveBranchForActor(bucket, rootId, account, "writer"),
    ).rejects.toMatchObject({ code: "owner_root_history_conflict" });
  });
});

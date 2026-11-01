import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { onRequest as stateRequest } from "../../nullplug/state";
import { onRequest as submitRequest } from "../../nullplug/submit";
import { onRequest as diffRequest } from "../../diff/[id]";
import type {
  DropBranchRuntimeFact,
  DropDiffPollResponse,
} from "../../../../shared/drop/diff";
import type { BranchRuntimeFactStatePlane } from "../../../../shared/drop/branch-runtime-facts";
import { BranchStateError } from "../../../../shared/drop/branch-state";
import { hashMarkdownSource } from "../../../../shared/drop/resolved/hash";
import {
  nullplugUiResponseFactKey,
  nullplugUiRuntimeFactId,
  nullplugUiStatePatchFactKey,
  nullplugUiStateSnapshotKey,
  type NullplugUiRuntimeFact,
} from "../../../../shared/nullplug/ui";
import { MemoryBranchCommitStatePlane } from "../../../../src/server/state-plane/memory-commits";
import { createLocalBranchLifecycle } from "../../../../src/server/state-plane/application-lifecycle";
import type { LocalBranchApplicationSelection } from "../../../../src/server/state-plane/commit-application";
import type {
  BlobObjectStore,
  SqlMetadataStore,
} from "../../../../src/server/ports";
import {
  MemoryD1Database,
  MemoryR2Bucket,
} from "../diffs/testing/storage-fixture";
import { createRemoteAliasKey } from "../drops/identity/id";

const rootDropId = "LocalFactsRoot01";
const owner = "account-owner";
const writer = "account-writer";
const content = "# Initial source\n";
const placement = { routingVersion: 1, generation: 3 };
const kinds = ["ui.response", "ui.state.patch", "ui.state.snapshot"] as const;

interface Receipt {
  stored: boolean;
  duplicate: boolean;
  indexed: boolean;
  key: string;
  fact: NullplugUiRuntimeFact;
  runtimeFact: { event: DropBranchRuntimeFact; appended: boolean };
}

const fixture = async (actor = writer) => {
  const blobs = new MemoryR2Bucket();
  const db = new MemoryD1Database();
  const backend = await MemoryBranchCommitStatePlane.create([], () => 1000);
  const branchId = actor === owner ? "owner" : `clone_account:${actor}`;
  const target = { rootDropId, branchId };
  const query = { target, placement };
  const initialize = async (accountId: string) => {
    const target = {
      rootDropId,
      branchId: accountId === owner ? "owner" : `clone_account:${accountId}`,
    };
    const command = {
      target,
      placement,
      reservationId: `reservation-${accountId}`,
      rootRevision: "root-revision-1",
    };
    await backend.reserve({
      ...command,
      identity: {
        baseDropId: rootDropId,
        mode: accountId === owner ? "owner" : "clone",
        ownerAccountId: owner,
        writerAccountId: accountId,
        writerClientId: null,
      },
    });
    await backend.initialize({ ...command, content });
    return target.branchId;
  };
  await initialize(actor);
  const project = (
    visibility: unknown = "private",
    deletedAt: number | null = null,
  ) => {
    db.accountLibraryEntries.set(rootDropId, {
      entry_seq: 1,
      drop_id: rootDropId,
      account_id: owner,
      visibility,
      created_at: 1,
      updated_at: 1,
      deleted_at: deletedAt,
    });
  };
  project();
  const runtimeFacts: BranchRuntimeFactStatePlane = backend;
  const selection: LocalBranchApplicationSelection = {
    mode: "local-test",
    placement,
    commits: backend,
    history: backend,
    runtimeFacts,
    lifecycle: createLocalBranchLifecycle({
      mode: "local-test",
      blobs: blobs as unknown as BlobObjectStore,
      sql: db as unknown as SqlMetadataStore,
      backend,
      initialPlacement: placement,
      isEligibleRoot: (id) => id === rootDropId,
    }),
  };
  const env = {
    R2_BUCKET: blobs as unknown as R2Bucket,
    DB: db as unknown as D1Database,
    ALLOW_INSECURE_ACCOUNT_HEADER: "1",
    ACCOUNT_AUTH_SECRET: "local-facts-test-secret",
    localBranchApplication: selection,
  };
  const hash = await hashMarkdownSource(content);
  const fact = (
    kind: (typeof kinds)[number],
    id = "fact-1",
  ): NullplugUiRuntimeFact => {
    const common = {
      version: 1 as const,
      id,
      createdAt: 12,
      source: {
        rootDropId,
        branchId,
        snapshotId: 99,
        sourceContentHash: hash,
        callId: "call-1",
      },
      metadata: { actorAccountId: "spoofed-account", retained: true },
    };
    if (kind === "ui.response")
      return {
        ...common,
        kind,
        primitiveId: "primitive-1",
        data: { approved: true },
      };
    if (kind === "ui.state.patch")
      return {
        ...common,
        kind,
        callId: "call-1",
        patch: [{ op: "set", path: [" approved "], value: true }],
      };
    return {
      ...common,
      kind,
      callId: "call-1",
      state: { approved: true },
      patchIds: ["prior-patch"],
    };
  };
  const headers = (account: string | null) => ({
    "Content-Type": "application/json",
    ...(account === null ? {} : { "x-nulldown-account-id": account }),
  });
  const post = async <T extends NullplugUiRuntimeFact>(
    value: T,
    account: string | null = actor,
  ): Promise<Response> => {
    const handler = value.kind === "ui.response" ? submitRequest : stateRequest;
    const path = value.kind === "ui.response" ? "submit" : "state";
    return (await handler({
      request: new Request(`https://nulldown.test/api/nullplug/${path}`, {
        method: "POST",
        headers: headers(account),
        body: JSON.stringify(value),
      }),
      env,
      params: {},
    } as unknown as Parameters<typeof handler>[0])) as unknown as Response;
  };
  const poll = async (
    account: string | null = actor,
    suffix = "cursor=-1&factCursor=-1",
    requestedBranch = branchId,
  ): Promise<Response> =>
    (await diffRequest({
      request: new Request(
        `https://nulldown.test/api/diff/${rootDropId}?${suffix}&branchId=${encodeURIComponent(requestedBranch)}`,
        { headers: headers(account) },
      ),
      env,
      params: { id: rootDropId },
    } as unknown as Parameters<typeof diffRequest>[0])) as unknown as Response;
  const edit = () =>
    backend.appendBatch({
      ...query,
      events: [
        {
          eventId: "edit-1",
          dropId: rootDropId,
          seq: 0,
          sourceClientId: "client-1",
          createdAt: 20,
          ops: [{ type: "insert", start: 0, end: 0, text: "Changed\n" }],
          metadata: { followsSeq: -1 },
        },
      ],
    });
  const put = jest.spyOn(blobs, "put");
  const remove = jest.spyOn(blobs, "delete");
  const factHead = jest.spyOn(backend, "readRuntimeFactHead");
  const factPage = jest.spyOn(backend, "readRuntimeFacts");
  const eventPage = jest.spyOn(backend, "readEvents");
  const assertNoLegacyWrites = () => {
    expect(put).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(db.runCalls).toBe(0);
    expect(db.batchCalls).toEqual([]);
    expect(blobs.getCalls).not.toContain(rootDropId);
    expect(blobs.listCalls).toEqual([]);
  };
  return {
    backend,
    selection,
    db,
    blobs,
    query,
    branchId,
    fact,
    post,
    poll,
    edit,
    project,
    initialize,
    factHead,
    factPage,
    eventPage,
    assertNoLegacyWrites,
  };
};

describe("selected local Nullplug runtime facts through Pages routes", () => {
  beforeEach(() => {
    for (const method of ["info", "warn", "error", "debug"] as const) {
      jest.spyOn(console, method).mockImplementation(() => {});
    }
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each(kinds)(
    "stores %s with an immutable receipt and no legacy projection",
    async (kind) => {
      const f = await fixture();
      const fact = f.fact(kind);
      const before = await f.backend.readHead(f.query);
      const response = await f.post(fact);
      expect({
        status: response.status,
        error: response.ok ? null : await response.clone().text(),
      }).toEqual({ status: 200, error: null });
      const body = (await response.json()) as Receipt;
      const key =
        fact.kind === "ui.response"
          ? nullplugUiResponseFactKey(fact)
          : fact.kind === "ui.state.patch"
            ? nullplugUiStatePatchFactKey(fact)
            : nullplugUiStateSnapshotKey(fact);
      expect(body).toMatchObject({
        stored: true,
        duplicate: false,
        indexed: false,
        key,
      });
      expect(body.fact).toEqual({
        ...fact,
        createdAt: 1000,
        source: { ...fact.source, snapshotId: 0 },
        metadata: { ...fact.metadata, actorAccountId: writer },
      });
      expect(body.runtimeFact).toMatchObject({
        appended: true,
        event: {
          version: 1,
          rootDropId,
          branchId: f.branchId,
          seq: 0,
          factId: nullplugUiRuntimeFactId(fact),
          fact: body.fact,
        },
      });
      expect(await f.backend.readHead(f.query)).toEqual(before);
      expect(await (await f.poll()).json()).toMatchObject({
        events: [],
        cursor: null,
        facts: [body.runtimeFact.event],
        factCursor: "0",
      });
      f.assertNoLegacyWrites();
    },
  );

  it.each(kinds)(
    "replays %s after a Markdown edit but rejects changed unknown fields",
    async (kind) => {
      const f = await fixture();
      const fact = {
        ...f.fact(kind),
        extension: { retained: ["raw"] },
        source: { ...f.fact(kind).source, extension: "source-raw" },
      };
      const first = await f.post(fact);
      expect(first.status).toBe(200);
      const receipt = (await first.json()) as Receipt;
      expect(receipt.fact).toMatchObject({
        extension: fact.extension,
        source: { extension: "source-raw" },
      });
      if (receipt.fact.kind === "ui.state.patch")
        expect(receipt.fact.patch[0].path).toEqual([" approved "]);
      await f.edit();
      const retry = await f.post({
        ...fact,
        createdAt: 9999,
        source: { ...fact.source, snapshotId: -123 },
      });
      expect(retry.status).toBe(200);
      expect(await retry.json()).toEqual({
        ...receipt,
        duplicate: true,
        runtimeFact: { ...receipt.runtimeFact, appended: false },
      });
      const conflict = await f.post({
        ...fact,
        extension: { retained: ["changed"] },
      });
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toMatchObject({
        code: "idempotency_key_reused",
      });
      const sourceConflict = await f.post({
        ...fact,
        source: { ...fact.source, extension: "changed-source-extension" },
      });
      expect(sourceConflict.status).toBe(409);
      expect(await sourceConflict.json()).toMatchObject({
        code: "idempotency_key_reused",
      });
      const otherActor = await f.post(fact, owner);
      expect(otherActor.status).toBe(409);
      expect(await otherActor.json()).toMatchObject({
        code: "idempotency_key_reused",
      });
      const freshIdentity = await f.post({ ...fact, id: "new-stale-fact" });
      expect(freshIdentity.status).toBe(409);
      expect(await freshIdentity.json()).toMatchObject({
        code: "stale_source",
      });
      expect(await f.backend.readRuntimeFactHead(f.query)).toMatchObject({
        headSeq: 0,
      });
      f.assertNoLegacyWrites();
    },
  );

  it("keeps proposed diffs as fact data without modifying Markdown", async () => {
    const f = await fixture();
    const fact = f.fact("ui.response");
    if (fact.kind !== "ui.response")
      throw new Error("Expected response fixture");
    const proposedDiffs = {
      version: 1 as const,
      events: [
        {
          eventId: "proposal",
          dropId: rootDropId,
          sourceClientId: "client-1",
          seq: 0,
          createdAt: 10,
          ops: [
            { type: "insert" as const, start: 0, end: 0, text: "NOT APPLIED" },
          ],
        },
      ],
    };
    const before = await f.backend.readHead(f.query);
    const response = await f.post({ ...fact, proposedDiffs });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ fact: { proposedDiffs } });
    expect(await f.backend.readHead(f.query)).toEqual(before);
    expect(
      await f.backend.readContent({ ...f.query, version: before.version }),
    ).toMatchObject({ content });
    f.assertNoLegacyWrites();
  });

  it.each(["key", "public-id"] as const)(
    "rejects conflicting %s aliases without appending another fact",
    async (collision) => {
      const f = await fixture();
      const base = f.fact("ui.state.patch");
      if (base.kind !== "ui.state.patch")
        throw new Error("Expected patch fixture");
      const first = {
        ...base,
        callId: collision === "key" ? "call" : "a:b",
        id: collision === "key" ? "a/b" : "c",
      };
      const second = {
        ...base,
        callId: collision === "key" ? "call" : "a",
        id: collision === "key" ? "a_b" : "b:c",
      };
      expect((await f.post(first)).status).toBe(200);
      const rejected = await f.post(second);
      expect(rejected.status).toBe(409);
      expect(await rejected.json()).toMatchObject({
        code: "idempotency_key_reused",
      });
      expect(await f.backend.readRuntimeFactHead(f.query)).toMatchObject({
        headSeq: 0,
      });
      f.assertNoLegacyWrites();
    },
  );

  it("supports full 134-character clone identities for submission and polling", async () => {
    const f = await fixture("a".repeat(120));
    expect(f.branchId).toHaveLength(134);
    for (const kind of kinds)
      expect((await f.post(f.fact(kind))).status).toBe(200);
    const response = await f.poll();
    expect(response.status).toBe(200);
    const page = (await response.json()) as DropDiffPollResponse;
    expect(page.factCursor).toBe("2");
    expect(page.facts).toHaveLength(3);
    for (const event of page.facts ?? [])
      expect(event.branchId).toBe(f.branchId);
    f.assertNoLegacyWrites();
  });

  it("keeps same IDs distinct across kinds, calls and primitives", async () => {
    const f = await fixture();
    const facts = kinds.flatMap((kind) => {
      const fact = f.fact(kind);
      return [
        fact,
        fact.kind === "ui.response"
          ? { ...fact, primitiveId: "primitive-2" }
          : { ...fact, callId: "call-2" },
      ];
    });
    for (const fact of facts) expect((await f.post(fact)).status).toBe(200);
    const response = await f.poll();
    expect(response.status).toBe(200);
    const page = (await response.json()) as DropDiffPollResponse;
    expect(page.facts?.map((event) => event.factId)).toEqual(
      facts.map(nullplugUiRuntimeFactId),
    );
    expect(page.factCursor).toBe("5");
    f.assertNoLegacyWrites();
  });

  it("does not fall back when the selected fact authority is absent or unavailable", async () => {
    const f = await fixture();
    const append = jest
      .spyOn(f.backend, "appendRuntimeFact")
      .mockRejectedValueOnce(new BranchStateError("state_unavailable"));
    const unavailable = await f.post(f.fact("ui.response"));
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({
      code: "state_unavailable",
      details: { outcome: "unknown", retry: "same-command" },
    });
    expect(append).toHaveBeenCalledTimes(1);
    delete f.selection.runtimeFacts;
    for (const kind of kinds) {
      const unsupported = await f.post(f.fact(kind));
      expect(unsupported.status).toBe(501);
      expect(await unsupported.json()).toMatchObject({
        code: "capability_unsupported",
      });
    }
    expect((await f.poll()).status).toBe(501);
    expect((await f.poll(writer, "cursor=-1")).status).toBe(200);
    expect(append).toHaveBeenCalledTimes(1);
    f.assertNoLegacyWrites();
  });

  it("requires authentication and exact branch write authority before accepting facts", async () => {
    const f = await fixture();
    f.project("public");
    for (const kind of kinds) {
      for (const [actor, status, code] of [
        [null, 401, "account_required"],
        ["unrelated", 403, "forbidden"],
      ] as const) {
        const response = await f.post(f.fact(kind), actor);
        expect(response.status).toBe(status);
        expect(await response.json()).toMatchObject({ code });
      }
      const withoutHash = f.fact(kind);
      delete withoutHash.source.sourceContentHash;
      const response = await f.post(withoutHash);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: "source_hash_required",
      });
    }
    expect(await f.backend.readRuntimeFactHead(f.query)).toMatchObject({
      headSeq: -1,
    });
    f.assertNoLegacyWrites();
  });

  it.each([
    { label: "tombstoned", visibility: "private", deletedAt: 2 },
    { label: "malformed", visibility: "unknown", deletedAt: null },
  ])(
    "denies $label roots before appending new or duplicate facts",
    async ({ visibility, deletedAt }) => {
      const f = await fixture();
      for (const kind of kinds)
        expect((await f.post(f.fact(kind))).status).toBe(200);
      const append = jest.spyOn(f.backend, "appendRuntimeFact");
      f.project(visibility, deletedAt);
      for (const kind of kinds) {
        for (const id of ["fact-1", "fresh-after-revocation"]) {
          const response = await f.post(f.fact(kind, id));
          expect(response.status).toBe(404);
          expect(await response.json()).toMatchObject({
            code: "root_drop_not_found",
          });
        }
      }
      expect(append).not.toHaveBeenCalled();
      expect(await f.backend.readRuntimeFactHead(f.query)).toMatchObject({
        headSeq: 2,
      });
      f.assertNoLegacyWrites();
    },
  );

  it.each([writer, owner])(
    "rechecks private canonical ownership while retaining exact writer %s",
    async (actor) => {
      const f = await fixture(actor);
      for (const kind of kinds)
        expect((await f.post(f.fact(kind), owner)).status).toBe(200);
      const entry = f.db.accountLibraryEntries.get(rootDropId)!;
      f.db.accountLibraryEntries.set(rootDropId, {
        ...entry,
        account_id: "replacement-owner",
      });
      const append = jest.spyOn(f.backend, "appendRuntimeFact");
      for (const kind of kinds) {
        for (const id of ["fact-1", "old-owner-new-fact"]) {
          const response = await f.post(f.fact(kind, id), owner);
          expect(response.status).toBe(actor === owner ? 200 : 404);
          if (actor !== owner)
            expect(await response.json()).toMatchObject({
              code: "root_drop_not_found",
            });
        }
      }
      if (actor !== owner) expect(append).not.toHaveBeenCalled();
      for (const kind of kinds) {
        const fact = f.fact(kind, "exact-writer-fact");
        expect((await f.post(fact, actor)).status).toBe(200);
        const retry = await f.post(fact, actor);
        expect(retry.status).toBe(200);
        expect(await retry.json()).toMatchObject({ duplicate: true });
      }
      f.assertNoLegacyWrites();
    },
  );

  it.each(kinds)(
    "resolves R2-only aliases read-only for authorized and forbidden %s submissions",
    async (kind) => {
      const f = await fixture();
      f.project("public");
      const alias = ["LfRa01", "LfRa02", "LfRa03"][kinds.indexOf(kind)];
      f.blobs.seed(createRemoteAliasKey(alias), rootDropId, "text/plain");
      const fact = f.fact(kind);
      const aliased = {
        ...fact,
        source: { ...fact.source, rootDropId: alias },
      };
      const append = jest.spyOn(f.backend, "appendRuntimeFact");
      const forbidden = await f.post(aliased, "unrelated-account");
      expect(forbidden.status).toBe(403);
      expect(await forbidden.json()).toMatchObject({ code: "forbidden" });
      f.assertNoLegacyWrites();
      append.mockClear();
      const response = await f.post(aliased);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        stored: true,
        indexed: false,
        fact: { source: { rootDropId, branchId: f.branchId } },
      });
      expect(append).toHaveBeenCalledTimes(1);
      const retry = await f.post(fact);
      expect(retry.status).toBe(200);
      expect(await retry.json()).toMatchObject({ duplicate: true });
      expect(await f.backend.readRuntimeFactHead(f.query)).toMatchObject({
        headSeq: 0,
      });
      f.assertNoLegacyWrites();
    },
  );

  it.each(["9007199254740992", "9".repeat(100)])(
    "returns an empty fact tail for large positive cursor %s without unsafe backend queries",
    async (cursor) => {
      const f = await fixture();
      expect((await f.post(f.fact("ui.state.snapshot"))).status).toBe(200);
      const response = await f.poll(writer, `cursor=-1&factCursor=${cursor}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        events: [],
        cursor: null,
        facts: [],
        factCursor: null,
      });
      for (const [query] of f.factPage.mock.calls) {
        expect(Number.isSafeInteger(query.afterSeq)).toBe(true);
        expect(query.afterSeq).toBeGreaterThanOrEqual(0);
      }
      f.assertNoLegacyWrites();
    },
  );

  it("keeps fact pagination independent of Markdown cursors and client filtering", async () => {
    const f = await fixture();
    for (const kind of kinds)
      expect((await f.post(f.fact(kind))).status).toBe(200);
    await f.edit();
    const first = await f.poll(
      writer,
      "cursor=-1&factCursor=-1&factLimit=2&excludeClient=client-1",
    );
    const page = (await first.json()) as DropDiffPollResponse;
    expect(page).toMatchObject({ events: [], cursor: "0", factCursor: "1" });
    expect(
      page.facts?.map((event: DropBranchRuntimeFact) => event.seq),
    ).toEqual([0, 1]);
    expect(
      await (await f.poll(writer, "cursor=0&factCursor=1&factLimit=2")).json(),
    ).toMatchObject({
      events: [],
      cursor: null,
      factCursor: "2",
      facts: [expect.objectContaining({ seq: 2 })],
    });
    expect(
      await (await f.poll(writer, "cursor=0&factCursor=2")).json(),
    ).toMatchObject({ events: [], facts: [], factCursor: null });
    expect(
      await (await f.poll(writer, "cursor=__latest__&factCursor=-1")).json(),
    ).toEqual({ events: [], cursor: "0", facts: [], factCursor: "2" });
    expect(
      await (await f.poll(writer, "cursor=-1&factCursor=__latest__")).json(),
    ).toMatchObject({
      events: [expect.objectContaining({ eventId: "edit-1" })],
      facts: [],
      factCursor: "2",
    });
    const ordinary = await (await f.poll(writer, "cursor=0")).json();
    expect(ordinary).not.toHaveProperty("facts");
    expect(ordinary).not.toHaveProperty("factCursor");
    f.assertNoLegacyWrites();
  });

  it("allows private canonical-owner and exact-writer fact reads while hiding siblings", async () => {
    const f = await fixture();
    const sibling = await f.initialize("sibling");
    expect((await f.post(f.fact("ui.response"))).status).toBe(200);
    for (const actor of [owner, writer]) {
      const response = await f.poll(actor);
      expect(response.status).toBe(200);
      expect(
        ((await response.json()) as DropDiffPollResponse).facts,
      ).toHaveLength(1);
    }
    f.factHead.mockClear();
    f.factPage.mockClear();
    f.eventPage.mockClear();
    for (const [actor, branch] of [
      [null, f.branchId],
      ["unrelated", f.branchId],
      [writer, sibling],
    ] as const) {
      const response = await f.poll(actor, "cursor=-1&factCursor=-1", branch);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("Branch not found.");
    }
    expect(f.factHead).not.toHaveBeenCalled();
    expect(f.factPage).not.toHaveBeenCalled();
    expect(f.eventPage).not.toHaveBeenCalled();
    f.assertNoLegacyWrites();
  });

  it.each(["public", "unlisted"])(
    "requires sensitive authorization for %s latest-only and ordinary fact polls",
    async (visibility) => {
      const f = await fixture();
      f.project(visibility);
      for (const cursor of ["-1", "__latest__"]) {
        for (const actor of [null, "unrelated"]) {
          const response = await f.poll(
            actor,
            `cursor=-1&factCursor=${cursor}`,
          );
          expect(response.status).toBe(403);
          expect(await response.text()).toBe(
            "You are not allowed to read runtime facts for this branch.",
          );
        }
      }
      expect(f.factHead).not.toHaveBeenCalled();
      expect(f.factPage).not.toHaveBeenCalled();
      expect(f.eventPage).not.toHaveBeenCalled();
      expect((await f.poll(null, "cursor=-1")).status).toBe(200);
      for (const actor of [owner, writer])
        expect((await f.poll(actor)).status).toBe(200);
      f.assertNoLegacyWrites();
    },
  );

  it("hides denied roots before query validation and any authority stream access", async () => {
    const f = await fixture();
    const head = jest.spyOn(f.backend, "readHead");
    for (const [visibility, deletedAt, actor] of [
      ["private", null, null],
      ["unknown", null, owner],
      ["public", 2, owner],
    ] as const) {
      f.project(visibility, deletedAt);
      const response = await f.poll(
        actor,
        "cursor=invalid&factCursor=invalid&limit=0&factLimit=0",
      );
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("Branch not found.");
    }
    expect(head).not.toHaveBeenCalled();
    expect(f.factHead).not.toHaveBeenCalled();
    expect(f.factPage).not.toHaveBeenCalled();
    expect(f.eventPage).not.toHaveBeenCalled();
    f.assertNoLegacyWrites();
  });

  it("without an ownership projection grants fact reads only to the exact writer", async () => {
    const f = await fixture();
    f.db.accountLibraryEntries.delete(rootDropId);
    expect((await f.poll(owner)).status).toBe(403);
    const response = await f.poll(writer, "cursor=-1&factCursor=__latest__");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      events: [],
      cursor: null,
      facts: [],
      factCursor: "-1",
    });
    f.assertNoLegacyWrites();
  });

  it("uses projected canonical ownership rather than branch owner metadata for sensitive reads", async () => {
    const f = await fixture();
    f.project("public");
    const entry = f.db.accountLibraryEntries.get(rootDropId)!;
    f.db.accountLibraryEntries.set(rootDropId, {
      ...entry,
      account_id: "projected-owner",
    });
    expect((await f.poll(owner)).status).toBe(403);
    expect(f.factHead).not.toHaveBeenCalled();
    expect(f.factPage).not.toHaveBeenCalled();
    for (const actor of ["projected-owner", writer])
      expect((await f.poll(actor)).status).toBe(200);
    f.assertNoLegacyWrites();
  });
});

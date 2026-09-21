import { jest } from "@jest/globals";
import type { R2Bucket } from "@cloudflare/workers-types";
import { onRequestPost as onStorePost } from "../../../store";
import { createRemoteAliasKey } from "../identity/id";
import {
  createEnvelope,
  createProviderSigningPrivateJwk,
  createSignedOwnerEnvelope,
  createStoreDatabase,
  createStoreRequest,
  MemoryR2Bucket,
  RacingMemoryR2Bucket,
  serializeEnvelope,
} from "../testing/storage-fixture";

describe("drop store contracts", () => {
  let infoSpy: jest.SpiedFunction<typeof console.info>;
  let warnSpy: jest.SpiedFunction<typeof console.warn>;
  let errorSpy: jest.SpiedFunction<typeof console.error>;
  let debugSpy: jest.SpiedFunction<typeof console.debug>;

  beforeEach(() => {
    infoSpy = jest.spyOn(console, "info").mockImplementation(() => {});
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    debugSpy = jest.spyOn(console, "debug").mockImplementation(() => {});
  });

  afterEach(() => {
    infoSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    debugSpy.mockRestore();
  });

  it("returns 409 alias_conflict from /api/store as structured JSON", async () => {
    const bucket = new MemoryR2Bucket();
    const existingId = "AaBbCc112233";
    const requestedId = "AaBbCc445566";

    bucket.seed(createRemoteAliasKey("AaBbCc"), existingId, "text/plain");

    const response = await onStorePost({
      request: createStoreRequest({
        id: requestedId,
        upsert: false,
        envelope: { content: "alias collision" },
      }),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        DB: createStoreDatabase() as never,
        PUBLIC_BASE_URL: "https://nulldown.test",
      },
    } as unknown as Parameters<typeof onStorePost>[0]);

    const body = (await response.json()) as {
      error: string;
      code: string;
      details?: Record<string, unknown>;
    };

    expect(response.status).toBe(409);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(body.code).toBe("alias_conflict");
    expect(body.error).toContain("already in use");
  });

  it("returns 412 revision_precondition_failed from /api/store as structured JSON", async () => {
    const bucket = new MemoryR2Bucket();
    const id = "QweRty123456";
    const accountId = "account-owner";
    const { envelope, signingPublicJwk } =
      await createSignedOwnerEnvelope(accountId);

    bucket.seed(
      id,
      serializeEnvelope(createEnvelope(accountId)),
      "application/json",
    );
    bucket.seed(createRemoteAliasKey("QweRty"), id, "text/plain");
    const db = createStoreDatabase({
      entry: {
        entry_seq: 1,
        drop_id: id,
        account_id: accountId,
        visibility: "unlisted",
        created_at: 1,
        updated_at: 1,
        deleted_at: null,
      },
      accounts: new Map([
        [
          accountId,
          {
            account_id: accountId,
            signing_public_jwk: JSON.stringify(signingPublicJwk),
            created_at: 1,
            updated_at: 1,
          },
        ],
      ]),
    });

    const response = await onStorePost({
      request: createStoreRequest(
        {
          id,
          upsert: true,
          expectedRevision: "mismatched-etag",
          envelope,
        },
        accountId,
      ),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        DB: db as never,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
        PUBLIC_BASE_URL: "https://nulldown.test",
      },
    } as unknown as Parameters<typeof onStorePost>[0]);

    const body = (await response.json()) as {
      error: string;
      code: string;
      details?: Record<string, unknown>;
    };

    expect(response.status).toBe(412);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(body.code).toBe("revision_precondition_failed");
    expect(body.error).toContain("Refresh and try again");
  });

  it("fails closed when an existing root has no ownership projection despite a valid revision", async () => {
    const bucket = new MemoryR2Bucket();
    const id = "QuoteRev1234";
    const original = serializeEnvelope(createEnvelope());

    const etag = bucket.seed(id, original, "application/json");
    bucket.seed(createRemoteAliasKey("QuoteR"), id, "text/plain");

    const response = await onStorePost({
      request: createStoreRequest({
        id,
        upsert: true,
        expectedRevision: `"${etag}"`,
        envelope: createEnvelope("account-2"),
      }),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        DB: createStoreDatabase() as never,
        PUBLIC_BASE_URL: "https://nulldown.test",
      },
    } as unknown as Parameters<typeof onStorePost>[0]);

    const body = (await response.json()) as { code: string };

    expect(response.status).toBe(503);
    expect(body.code).toBe("account_library_unavailable");
    await expect((await bucket.get(id))?.text()).resolves.toBe(original);
  });

  it.each(["public", "unlisted"] as const)(
    "does not provider-sign an anonymous %s account envelope creation",
    async (visibility) => {
      const bucket = new MemoryR2Bucket();
      const id = `Anonymous${visibility}`;
      const envelope = createEnvelope("account-owner");
      envelope.visibility = visibility;
      const providerSigningPrivateJwk = await createProviderSigningPrivateJwk();

      const response = await onStorePost({
        request: createStoreRequest({ id, upsert: true, envelope }),
        env: {
          R2_BUCKET: bucket as unknown as R2Bucket,
          DB: createStoreDatabase() as never,
          PROVIDER_SIGNING_PRIVATE_JWK: JSON.stringify(
            providerSigningPrivateJwk,
          ),
          LOG_LEVEL: "debug",
          PUBLIC_BASE_URL: "https://nulldown.test",
        },
      } as unknown as Parameters<typeof onStorePost>[0]);

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual(
        expect.objectContaining({ code: "account_auth_required" }),
      );
      expect(debugSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('"event":"store.provider_signature_applied"'),
      );
      await expect(bucket.get(id)).resolves.toBeNull();
    },
  );

  it("allows a verified owner to create a provider-signed envelope", async () => {
    const bucket = new MemoryR2Bucket();
    const id = "VerifiedCreate1";
    const accountId = "account-owner";
    const { envelope, signingPublicJwk } =
      await createSignedOwnerEnvelope(accountId);
    const providerSigningPrivateJwk = await createProviderSigningPrivateJwk();
    const db = createStoreDatabase({
      accounts: new Map([
        [
          accountId,
          {
            account_id: accountId,
            signing_public_jwk: JSON.stringify(signingPublicJwk),
            created_at: 1,
            updated_at: 1,
          },
        ],
      ]),
    });

    const response = await onStorePost({
      request: createStoreRequest({ id, upsert: true, envelope }, accountId),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        DB: db as never,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
        PROVIDER_SIGNING_PRIVATE_JWK: JSON.stringify(providerSigningPrivateJwk),
        PUBLIC_BASE_URL: "https://nulldown.test",
      },
    } as unknown as Parameters<typeof onStorePost>[0]);

    expect(response.status).toBe(200);
    await expect((await bucket.get(id))?.json()).resolves.toMatchObject({
      schema: "nmdn.drop.v1",
      version: 1,
      accountId,
      signatures: {
        provider: {
          kid: "provider-test",
          alg: "ECDSA_P256_SHA256",
          sig: expect.any(String),
        },
      },
    });
  });

  it("rejects an anonymous unlisted envelope overwrite before replacing a protected root", async () => {
    const bucket = new MemoryR2Bucket();
    const id = "ProtectedAnon01";
    const original = serializeEnvelope(createEnvelope("account-owner"));
    bucket.seed(id, original, "application/json");
    const db = createStoreDatabase({
      entry: {
        entry_seq: 1,
        drop_id: id,
        account_id: "account-owner",
        visibility: "unlisted",
        created_at: 1,
        updated_at: 1,
        deleted_at: null,
      },
    });

    const response = await onStorePost({
      request: createStoreRequest({
        id,
        upsert: true,
        envelope: createEnvelope("account-owner"),
      }),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        DB: db as never,
        PUBLIC_BASE_URL: "https://nulldown.test",
      },
    } as unknown as Parameters<typeof onStorePost>[0]);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ code: "account_auth_required" }),
    );
    await expect((await bucket.get(id))?.text()).resolves.toBe(original);
  });

  it("rejects a plaintext overwrite of a protected root", async () => {
    const bucket = new MemoryR2Bucket();
    const id = "ProtectedPlain02";
    const original = serializeEnvelope(createEnvelope("account-owner"));
    bucket.seed(id, original, "application/json");
    const db = createStoreDatabase({
      entry: {
        entry_seq: 1,
        drop_id: id,
        account_id: "account-owner",
        visibility: "unlisted",
        created_at: 1,
        updated_at: 1,
        deleted_at: null,
      },
    });

    const response = await onStorePost({
      request: createStoreRequest({
        id,
        upsert: true,
        envelope: { content: "replacement" },
      }),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        DB: db as never,
        PUBLIC_BASE_URL: "https://nulldown.test",
      },
    } as unknown as Parameters<typeof onStorePost>[0]);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ code: "account_owned_envelope_required" }),
    );
    await expect((await bucket.get(id))?.text()).resolves.toBe(original);
  });

  it("fails closed when metadata is unavailable for an existing root upsert", async () => {
    const bucket = new MemoryR2Bucket();
    const id = "ProtectedNoDb003";
    const original = serializeEnvelope(createEnvelope("account-owner"));
    bucket.seed(id, original, "application/json");

    const response = await onStorePost({
      request: createStoreRequest({
        id,
        upsert: true,
        envelope: createEnvelope("account-owner"),
      }),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        PUBLIC_BASE_URL: "https://nulldown.test",
      },
    } as unknown as Parameters<typeof onStorePost>[0]);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ code: "account_library_unavailable" }),
    );
    await expect((await bucket.get(id))?.text()).resolves.toBe(original);
  });

  it("allows a verified owner to replace a protected root", async () => {
    const bucket = new MemoryR2Bucket();
    const id = "ProtectedOwner4";
    const accountId = "account-owner";
    const original = serializeEnvelope(createEnvelope(accountId));
    const etag = bucket.seed(id, original, "application/json");
    const { envelope, signingPublicJwk } =
      await createSignedOwnerEnvelope(accountId);
    const providerSigningPrivateJwk = await createProviderSigningPrivateJwk();
    const db = createStoreDatabase({
      entry: {
        entry_seq: 1,
        drop_id: id,
        account_id: accountId,
        visibility: "unlisted",
        created_at: 1,
        updated_at: 1,
        deleted_at: null,
      },
      accounts: new Map([
        [
          accountId,
          {
            account_id: accountId,
            signing_public_jwk: JSON.stringify(signingPublicJwk),
            created_at: 1,
            updated_at: 1,
          },
        ],
      ]),
    });

    const response = await onStorePost({
      request: createStoreRequest(
        { id, upsert: true, expectedRevision: etag, envelope },
        accountId,
      ),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        DB: db as never,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
        PROVIDER_SIGNING_PRIVATE_JWK: JSON.stringify(providerSigningPrivateJwk),
        PUBLIC_BASE_URL: "https://nulldown.test",
      },
    } as unknown as Parameters<typeof onStorePost>[0]);

    expect(response.status).toBe(200);
    await expect((await bucket.get(id))?.json()).resolves.toMatchObject({
      accountId,
      signatures: {
        device: expect.any(Object),
        provider: expect.objectContaining({ kid: "provider-test" }),
      },
    });
  });

  it("rejects a verified non-owner before replacing a protected root", async () => {
    const bucket = new MemoryR2Bucket();
    const id = "ProtectedForeign";
    const ownerAccountId = "account-owner";
    const foreignAccountId = "account-foreign";
    const original = serializeEnvelope(createEnvelope(ownerAccountId));
    bucket.seed(id, original, "application/json");
    const { envelope, signingPublicJwk } =
      await createSignedOwnerEnvelope(foreignAccountId);
    const db = createStoreDatabase({
      entry: {
        entry_seq: 1,
        drop_id: id,
        account_id: ownerAccountId,
        visibility: "unlisted",
        created_at: 1,
        updated_at: 1,
        deleted_at: null,
      },
      accounts: new Map([
        [
          foreignAccountId,
          {
            account_id: foreignAccountId,
            signing_public_jwk: JSON.stringify(signingPublicJwk),
            created_at: 1,
            updated_at: 1,
          },
        ],
      ]),
    });

    const response = await onStorePost({
      request: createStoreRequest(
        { id, upsert: true, envelope },
        foreignAccountId,
      ),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        DB: db as never,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
        PUBLIC_BASE_URL: "https://nulldown.test",
      },
    } as unknown as Parameters<typeof onStorePost>[0]);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ code: "account_mismatch" }),
    );
    await expect((await bucket.get(id))?.text()).resolves.toBe(original);
  });

  it("does not overwrite a root that changes after its ownership check", async () => {
    const bucket = new RacingMemoryR2Bucket();
    const id = "RaceLock00005";
    const accountId = "account-owner";
    const original = serializeEnvelope(createEnvelope(accountId));
    bucket.seed(id, original, "application/json");
    const { envelope, signingPublicJwk } =
      await createSignedOwnerEnvelope(accountId);
    const db = createStoreDatabase({
      entry: {
        entry_seq: 1,
        drop_id: id,
        account_id: accountId,
        visibility: "unlisted",
        created_at: 1,
        updated_at: 1,
        deleted_at: null,
      },
      accounts: new Map([
        [
          accountId,
          {
            account_id: accountId,
            signing_public_jwk: JSON.stringify(signingPublicJwk),
            created_at: 1,
            updated_at: 1,
          },
        ],
      ]),
    });

    const response = await onStorePost({
      request: createStoreRequest({ id, upsert: true, envelope }, accountId),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        DB: db as never,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
        PUBLIC_BASE_URL: "https://nulldown.test",
      },
    } as unknown as Parameters<typeof onStorePost>[0]);

    expect(response.status).toBe(412);
    await expect((await bucket.get(id))?.text()).resolves.toBe(
      "concurrent replacement",
    );
  });

  it("requires the tombstoned owner to recreate a deleted root", async () => {
    const bucket = new MemoryR2Bucket();
    const id = "ProtectedTomb06";
    const ownerAccountId = "account-owner";
    const foreignAccountId = "account-foreign";
    const { envelope, signingPublicJwk } =
      await createSignedOwnerEnvelope(foreignAccountId);
    const db = createStoreDatabase({
      entry: {
        entry_seq: 1,
        drop_id: id,
        account_id: ownerAccountId,
        visibility: "unlisted",
        created_at: 1,
        updated_at: 1,
        deleted_at: 2,
      },
      accounts: new Map([
        [
          foreignAccountId,
          {
            account_id: foreignAccountId,
            signing_public_jwk: JSON.stringify(signingPublicJwk),
            created_at: 1,
            updated_at: 1,
          },
        ],
      ]),
    });

    const response = await onStorePost({
      request: createStoreRequest(
        { id, upsert: true, envelope },
        foreignAccountId,
      ),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        DB: db as never,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
        PUBLIC_BASE_URL: "https://nulldown.test",
      },
    } as unknown as Parameters<typeof onStorePost>[0]);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ code: "account_mismatch" }),
    );
    await expect(bucket.get(id)).resolves.toBeNull();
  });

  it("allows a verified owner to reclaim a tombstoned root", async () => {
    const bucket = new MemoryR2Bucket();
    const id = "TombOwner0007";
    const accountId = "account-owner";
    const { envelope, signingPublicJwk } =
      await createSignedOwnerEnvelope(accountId);
    const db = createStoreDatabase({
      entry: {
        entry_seq: 1,
        drop_id: id,
        account_id: accountId,
        visibility: "unlisted",
        created_at: 1,
        updated_at: 1,
        deleted_at: 2,
      },
      accounts: new Map([
        [
          accountId,
          {
            account_id: accountId,
            signing_public_jwk: JSON.stringify(signingPublicJwk),
            created_at: 1,
            updated_at: 1,
          },
        ],
      ]),
    });

    const response = await onStorePost({
      request: createStoreRequest({ id, upsert: true, envelope }, accountId),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        DB: db as never,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
        PUBLIC_BASE_URL: "https://nulldown.test",
      },
    } as unknown as Parameters<typeof onStorePost>[0]);

    expect(response.status).toBe(200);
    await expect((await bucket.get(id))?.json()).resolves.toMatchObject({
      accountId,
    });
  });

  it("rejects an empty bearer token for an unlisted envelope", async () => {
    const bucket = new MemoryR2Bucket();
    const request = createStoreRequest({
      envelope: createEnvelope("account-owner"),
    });
    request.headers.set("Authorization", "Bearer");

    const response = await onStorePost({
      request,
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        DB: createStoreDatabase() as never,
        PUBLIC_BASE_URL: "https://nulldown.test",
      },
    } as unknown as Parameters<typeof onStorePost>[0]);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ code: "account_auth_required" }),
    );
  });
});

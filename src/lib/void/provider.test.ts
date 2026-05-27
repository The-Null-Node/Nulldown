import { jest } from "@jest/globals";
import { indexedDB } from "fake-indexeddb";
import {
  createLocalVoidProvider,
  createRemoteVoidProvider,
  createVoidProviderRegistry,
} from "./provider";
import type { VoidCrypto } from "./crypto/browserVoidCrypto";
import type { DropEnvelopeV1, DropPayload } from "../../../shared/drop/types";

const ensureWindowWithIndexedDb = () => {
  const currentWindow = (globalThis as { window?: unknown }).window as
    | { indexedDB?: IDBFactory; location?: { origin: string } }
    | undefined;

  if (!currentWindow) {
    Object.defineProperty(globalThis, "window", {
      value: {
        indexedDB,
        location: { origin: "https://nulldown.test" },
      },
      configurable: true,
    });
    return;
  }

  currentWindow.indexedDB = indexedDB;
  currentWindow.location = { origin: "https://nulldown.test" };
};

const createEnvelope = (): DropEnvelopeV1 => ({
  schema: "nmdn.drop.v1",
  version: 1,
  createdAt: Date.now(),
  accountId: "account-1",
  metadata: { themeId: "system" },
  cipher: {
    alg: "A256GCM",
    iv: "AQID",
    ciphertext: "BAUG",
  },
  keyEnvelope: {
    mode: "account-vault-rsa-oaep",
    kid: "enc-kid",
    wrappedKey: "BwgJ",
  },
  signatures: {
    device: {
      kid: "sig-kid",
      alg: "ECDSA_P256_SHA256",
      sig: "CgsM",
    },
  },
});

const createCryptoPort = (
  payload: DropPayload,
  envelope = createEnvelope(),
): VoidCrypto => ({
  seal: jest.fn<VoidCrypto["seal"]>().mockResolvedValue(envelope),
  open: jest.fn<VoidCrypto["open"]>().mockResolvedValue(payload),
});

describe("void providers", () => {
  beforeEach(() => {
    ensureWindowWithIndexedDb();
    (globalThis as { fetch?: typeof fetch }).fetch = jest.fn<typeof fetch>();
  });

  it("creates and reads local drops with createLocalVoidProvider", async () => {
    const payload: DropPayload = {
      content: "local content",
      metadata: { themeId: "system" },
    };
    const envelope = createEnvelope();
    const cryptoPort = createCryptoPort(payload, envelope);
    const provider = createLocalVoidProvider({
      crypto: cryptoPort,
    });

    const created = await provider.create(payload);
    const shortId = created.id.slice(0, 6);

    expect(created.scope).toBe("local");
    expect(created.id).toHaveLength(12);
    expect(created.url).toBe(`https://nulldown.test/d/${shortId}`);

    const opened = await provider.get(created.id);
    const openedFromShortId = await provider.get(shortId);

    expect(opened).toEqual(payload);
    expect(openedFromShortId).toEqual(payload);
    expect(cryptoPort.seal).toHaveBeenCalledWith(payload, {
      visibility: undefined,
      unlockPolicy: undefined,
    });
    expect(cryptoPort.open).toHaveBeenCalledWith(envelope, { dropId: created.id });
    expect(cryptoPort.open).toHaveBeenCalledWith(envelope, { dropId: created.id });
  });

  it("creates and reads remote drops with createRemoteVoidProvider", async () => {
    const payload: DropPayload = {
      content: "remote content",
      metadata: { themeId: "system" },
    };
    const envelope = createEnvelope();
    const cryptoPort = createCryptoPort(payload, envelope);
    const provider = createRemoteVoidProvider({
      crypto: cryptoPort,
    });

    const fetchMock = globalThis.fetch as jest.MockedFunction<typeof fetch>;

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ id: "abc123def456", url: "https://app/d/abc123" }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        },
      ),
    );

    const created = await provider.create(payload);

    expect(created).toEqual({
      id: "abc123def456",
      url: "https://app/d/abc123",
      scope: "remote",
    });

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(envelope), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "X-Drop-Canonical-Id": "abc123def456",
        },
      }),
    );

    const opened = await provider.get("abc123");

    expect(opened).toEqual(payload);
    expect(cryptoPort.open).toHaveBeenCalledWith(envelope, {
      dropId: "abc123def456",
    });
  });

  it("resolves graph lineage and uses cache on subsequent reads", async () => {
    const headId = `head_${Date.now()}`;
    const rootId = `root_${Date.now()}`;
    const payloadHead: DropPayload = {
      content: "head",
      metadata: { baseDropId: rootId },
    };
    const payloadRoot: DropPayload = {
      content: "root",
      metadata: {},
    };

    const registry = createVoidProviderRegistry({
      crypto: createCryptoPort({ content: "unused" }),
    });

    const fetchMock = globalThis.fetch as jest.MockedFunction<typeof fetch>;

    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify(payloadHead), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(payloadRoot), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        }),
      );

    const firstGraph = await registry.remote.resolveGraph(headId);

    expect(firstGraph.headId).toBe(headId);
    expect(firstGraph.rootId).toBe(rootId);
    expect(firstGraph.lineage).toEqual([headId, rootId]);
    expect(fetchMock.mock.calls).toHaveLength(2);

    const secondGraph = await registry.remote.resolveGraph(headId);

    expect(secondGraph.lineage).toEqual([headId, rootId]);
    expect(fetchMock.mock.calls).toHaveLength(2);
  });

  it("selects provider by drop id with createVoidProviderRegistry", () => {
    const registry = createVoidProviderRegistry({
      crypto: createCryptoPort({ content: "unused" }),
    });

    expect(registry.forDropId("offline_abc").scope).toBe("local");
    expect(registry.forDropId("abc123").scope).toBe("remote");
  });
});

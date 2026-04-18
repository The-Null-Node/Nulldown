import { createHmac, randomUUID } from "node:crypto";
import {
  DIFF_CLIENT_ID_HEADER,
  DIFF_SECRET_KID_HEADER,
  DIFF_SIGNATURE_HEADER,
  DIFF_TIMESTAMP_HEADER,
  type DiffAuthRegisterResponse,
} from "../shared/drop/diffAuth";
import type { DropDiffEnvelope } from "../shared/drop/diff";
import {
  keysFilePath,
  readJsonFile,
  resolveBaseUrl,
  signDiffPayload,
  type DiffClientKeysRecord,
} from "./diffAuthUtil";

interface RequestJsonResult<T = unknown> {
  response: Response;
  text: string;
  json: T | null;
}

interface RegisterContext {
  clientId: string;
  kid: string;
  secret: string;
}

const BASE_URL = resolveBaseUrl();
const DIFF_SECRET = process.env.DIFF_WEBHOOK_SECRET || "";

const assert = (condition: boolean, message: string): void => {
  if (!condition) {
    throw new Error(message);
  }
};

const signBodyLegacy = (body: string, secret: string): string => {
  const hex = createHmac("sha256", secret).update(body).digest("hex");
  return `sha256=${hex}`;
};

const requestJson = async <T>(
  url: string,
  options: RequestInit = {},
): Promise<RequestJsonResult<T>> => {
  const response = await fetch(url, options);
  const text = await response.text();
  let json: T | null = null;

  try {
    json = text ? (JSON.parse(text) as T) : null;
  } catch {
    json = null;
  }

  return { response, text, json };
};

const createDrop = async (): Promise<string> => {
  const { response, text, json } = await requestJson<{ id: string }>(
    `${BASE_URL}/api/store`,
    {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: `diff-test-${Date.now()}`,
    },
  );

  assert(response.ok, `createDrop failed: ${response.status} ${text}`);
  assert(json !== null && typeof json.id === "string", "createDrop response missing id");
  if (!json) {
    throw new Error("createDrop response missing id");
  }

  return json.id;
};

const unwrapSecret = async (
  wrappedSecretBase64: string,
  privateJwk: JsonWebKey,
): Promise<string> => {
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    privateJwk,
    {
      name: "RSA-OAEP",
      hash: "SHA-256",
    },
    false,
    ["decrypt"],
  );

  const wrappedBytes = new Uint8Array(Buffer.from(wrappedSecretBase64, "base64"));
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "RSA-OAEP",
    },
    privateKey,
    wrappedBytes,
  );

  return new TextDecoder().decode(plaintext);
};

const registerProviderAuth = async (dropId: string): Promise<RegisterContext | null> => {
  const keys = await readJsonFile<DiffClientKeysRecord>(keysFilePath());
  if (!keys) {
    return null;
  }

  const { response, text, json } = await requestJson<DiffAuthRegisterResponse>(
    `${BASE_URL}/api/diff-auth/register/${encodeURIComponent(dropId)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        clientId: keys.clientId,
        requesterPublicJwk: keys.encryptionPublicJwk,
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`registerProviderAuth failed: ${response.status} ${text}`);
  }

  assert(json !== null, "registerProviderAuth response is empty");
  if (!json) {
    throw new Error("registerProviderAuth response is empty");
  }

  const secret = await unwrapSecret(json.wrappedSecret, keys.encryptionPrivateJwk);
  return {
    clientId: json.clientId,
    kid: json.kid,
    secret,
  };
};

const postDiffEnvelope = async (
  dropId: string,
  envelope: DropDiffEnvelope,
  secret: string,
  authHeaders: { clientId: string; kid: string } | null,
): Promise<RequestJsonResult<{ accepted: number; totalStored: number }>> => {
  const body = JSON.stringify(envelope);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (authHeaders) {
    const timestamp = String(Date.now());
    const path = `/api/diff/${encodeURIComponent(dropId)}`;
    headers[DIFF_CLIENT_ID_HEADER] = authHeaders.clientId;
    headers[DIFF_SECRET_KID_HEADER] = authHeaders.kid;
    headers[DIFF_TIMESTAMP_HEADER] = timestamp;
    headers[DIFF_SIGNATURE_HEADER] = signDiffPayload(
      secret,
      "POST",
      path,
      timestamp,
      body,
    );
  } else if (secret) {
    headers[DIFF_SIGNATURE_HEADER] = signBodyLegacy(body, secret);
  }

  return requestJson<{ accepted: number; totalStored: number }>(
    `${BASE_URL}/api/diff/${encodeURIComponent(dropId)}`,
    {
      method: "POST",
      headers,
      body,
    },
  );
};

const getDiffs = async (
  dropId: string,
  params: Record<string, string | number | null>,
): Promise<RequestJsonResult<{ events: Array<{ eventId: string }>; cursor: string | null }>> => {
  const url = new URL(`${BASE_URL}/api/diff/${encodeURIComponent(dropId)}`);

  Object.entries(params).forEach(([key, value]) => {
    if (value !== null) {
      url.searchParams.set(key, String(value));
    }
  });

  return requestJson(url.toString(), { method: "GET" });
};

const main = async () => {
  console.log(`Base URL: ${BASE_URL}`);

  const dropId = await createDrop();
  console.log(`Created drop: ${dropId}`);

  const providerAuth = DIFF_SECRET ? null : await registerProviderAuth(dropId);
  const secret = DIFF_SECRET || providerAuth?.secret || "";

  console.log(`Auth mode: ${providerAuth ? "provider" : DIFF_SECRET ? "env-secret" : "none"}`);

  const clientId = providerAuth?.clientId || `test-client-${randomUUID()}`;
  const eventId = `evt-${randomUUID()}`;

  const envelope: DropDiffEnvelope = {
    version: 1,
    events: [
      {
        eventId,
        seq: 0,
        dropId,
        sourceClientId: clientId,
        createdAt: Date.now(),
        ops: [
          {
            type: "insert",
            start: 0,
            end: 0,
            text: "hello-from-webhook",
          },
        ],
      },
    ],
  };

  {
    const { response, text, json } = await postDiffEnvelope(
      dropId,
      envelope,
      secret,
      providerAuth ? { clientId: providerAuth.clientId, kid: providerAuth.kid } : null,
    );
    assert(
      response.status === 200,
      `valid POST expected 200, got ${response.status}: ${text}`,
    );
    assert(json !== null && json.accepted === 1, "valid POST expected accepted=1");
    console.log("PASS: valid POST accepted one event");
  }

  {
    const { response, text, json } = await postDiffEnvelope(
      dropId,
      envelope,
      secret,
      providerAuth ? { clientId: providerAuth.clientId, kid: providerAuth.kid } : null,
    );
    assert(
      response.status === 200,
      `duplicate POST expected 200, got ${response.status}: ${text}`,
    );
    assert(json !== null && json.accepted === 0, "duplicate POST expected accepted=0");
    console.log("PASS: duplicate POST deduplicated");
  }

  let cursor: string | null = null;

  {
    const { response, text, json } = await getDiffs(dropId, {
      cursor: -1,
      limit: 50,
    });

    assert(
      response.status === 200,
      `GET expected 200, got ${response.status}: ${text}`,
    );
    assert(Array.isArray(json?.events), "GET response missing events array");
    assert((json?.events.length || 0) >= 1, "GET expected at least one event");
    assert(json?.events[0]?.eventId === eventId, "GET first eventId mismatch");

    cursor = json?.cursor ?? null;
    console.log("PASS: GET returns appended event");
  }

  {
    const { response, text, json } = await getDiffs(dropId, {
      cursor,
      limit: 50,
    });

    assert(
      response.status === 200,
      `GET cursor expected 200, got ${response.status}: ${text}`,
    );
    assert(Array.isArray(json?.events), "GET cursor response missing events array");
    assert(
      (json?.events.length || 0) === 0,
      `GET cursor expected 0 events, got ${json?.events.length}`,
    );
    console.log("PASS: cursor paging works");
  }

  {
    const { response, text, json } = await getDiffs(dropId, {
      cursor: -1,
      excludeClient: clientId,
      limit: 50,
    });

    assert(
      response.status === 200,
      `GET excludeClient expected 200, got ${response.status}: ${text}`,
    );
    assert(Array.isArray(json?.events), "GET excludeClient missing events array");
    assert(
      (json?.events.length || 0) === 0,
      `GET excludeClient expected 0 events, got ${json?.events.length}`,
    );
    console.log("PASS: excludeClient filtering works");
  }

  if (providerAuth) {
    const badBody = JSON.stringify(envelope);
    const timestamp = String(Date.now());
    const badSig = signDiffPayload(
      "wrong-secret",
      "POST",
      `/api/diff/${encodeURIComponent(dropId)}`,
      timestamp,
      badBody,
    );

    const { response, text } = await requestJson(
      `${BASE_URL}/api/diff/${encodeURIComponent(dropId)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [DIFF_CLIENT_ID_HEADER]: providerAuth.clientId,
          [DIFF_SECRET_KID_HEADER]: providerAuth.kid,
          [DIFF_TIMESTAMP_HEADER]: timestamp,
          [DIFF_SIGNATURE_HEADER]: badSig,
        },
        body: badBody,
      },
    );

    assert(
      response.status === 403,
      `invalid provider signature expected 403, got ${response.status}: ${text}`,
    );
    console.log("PASS: invalid provider signature rejected");
  } else if (DIFF_SECRET) {
    const badBody = JSON.stringify(envelope);
    const { response, text } = await requestJson(
      `${BASE_URL}/api/diff/${encodeURIComponent(dropId)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [DIFF_SIGNATURE_HEADER]: "sha256=deadbeef",
        },
        body: badBody,
      },
    );

    assert(
      response.status === 403,
      `invalid env signature expected 403, got ${response.status}: ${text}`,
    );
    console.log("PASS: invalid env signature rejected");
  } else {
    console.log("SKIP: auth negative test (no provider auth and no env secret)");
  }

  console.log("All diff webhook tests passed.");
};

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`FAIL: ${message}`);
  process.exit(1);
});

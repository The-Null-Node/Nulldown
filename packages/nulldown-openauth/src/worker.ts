import { CloudflareStorage } from "@openauthjs/openauth/storage/cloudflare";
import type { D1Database } from "@cloudflare/workers-types";

import {
  createNulldownOpenAuthApplication,
  normalizeCodeAddress,
  parseOpenAuthClientRegistrations,
  type NulldownUserIdResolver,
  type OpenAuthCodeDelivery,
} from "./application";

const CODE_EMAIL_COOLDOWN_SECONDS = 60;
const CODE_EMAIL_COOLDOWN_PREFIX = "openauth:code-email:";
const DISCOVERY_PATH = "/.well-known/oauth-authorization-server";
const EMAIL_IDENTITY_PROVIDER_KEY = "email";
const textEncoder = new TextEncoder();

interface UserIdRow {
  user_id: string;
}

interface TransactionalEmailMessage {
  to: string;
  from: string;
  subject: string;
  html: string;
  text: string;
}

/** Structured Cloudflare Email Sending binding; generated Worker types predate this binding. */
interface TransactionalEmailBinding {
  send(message: TransactionalEmailMessage): Promise<unknown>;
}

class CodeEmailCooldownError extends Error {}

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });

const normalizeIssuerOrigin = (value: string | undefined): string | null => {
  if (!value) return null;

  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.origin !== value
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
};

const isKvNamespace = (value: unknown): value is KVNamespace => {
  if (!value || typeof value !== "object") return false;
  const namespace = value as Record<string, unknown>;
  return (
    typeof namespace.get === "function" &&
    typeof namespace.put === "function" &&
    typeof namespace.delete === "function" &&
    typeof namespace.list === "function"
  );
};

const isD1Database = (value: unknown): value is D1Database =>
  Boolean(value) &&
  typeof value === "object" &&
  typeof (value as Record<string, unknown>).prepare === "function";

const randomUserId = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return `user_${toBase64Url(bytes)}`;
};

const hashCooldownKey = async (address: string): Promise<string> =>
  `${CODE_EMAIL_COOLDOWN_PREFIX}${toBase64Url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", textEncoder.encode(address))),
  )}`;

const readEmailIdentity = async (
  db: D1Database,
  issuer: string,
  address: string,
): Promise<string | null> => {
  const identity = await db
    .prepare(
      `SELECT user_id
       FROM auth_external_identities
       WHERE issuer = ? AND provider_key = ? AND provider_subject = ?`,
    )
    .bind(issuer, EMAIL_IDENTITY_PROVIDER_KEY, address)
    .first<UserIdRow>();
  return identity?.user_id ?? null;
};

const deleteUnusedCandidateUser = async (db: D1Database, userId: string): Promise<void> => {
  await db
    .prepare(
      `DELETE FROM auth_users
       WHERE user_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM auth_external_identities WHERE user_id = ?
         )`,
    )
    .bind(userId, userId)
    .run();
};

const createD1UserIdResolver = (
  db: D1Database,
  issuer: string,
): NulldownUserIdResolver => ({
  async resolveUserId({ address }) {
    const normalizedAddress = normalizeCodeAddress(address);
    if (!normalizedAddress || normalizedAddress !== address) {
      throw new TypeError("OpenAuth identity address must be normalized.");
    }

    const existing = await readEmailIdentity(db, issuer, normalizedAddress);
    if (existing) return existing;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const candidateUserId = randomUserId();
      const now = Date.now();
      const created = await db
        .prepare(
          `INSERT INTO auth_users (user_id, created_at, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(user_id) DO NOTHING
           RETURNING user_id`,
        )
        .bind(candidateUserId, now, now)
        .first<UserIdRow>();

      if (!created) {
        const winner = await readEmailIdentity(db, issuer, normalizedAddress);
        if (winner) return winner;
        continue;
      }

      try {
        await db
          .prepare(
            `INSERT INTO auth_external_identities (
               issuer, provider_key, provider_subject, user_id, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(issuer, provider_key, provider_subject) DO NOTHING`,
          )
          .bind(
            issuer,
            EMAIL_IDENTITY_PROVIDER_KEY,
            normalizedAddress,
            candidateUserId,
            now,
            now,
          )
          .run();

        const winner = await readEmailIdentity(db, issuer, normalizedAddress);
        if (winner) {
          if (winner !== candidateUserId) {
            try {
              await deleteUnusedCandidateUser(db, candidateUserId);
            } catch {
              // A failed cleanup can leave an unreferenced candidate, which has no identity or legacy authority.
            }
          }
          return winner;
        }

        try {
          await deleteUnusedCandidateUser(db, candidateUserId);
        } catch {
          // An inconsistent identity read can leave only the same benign unreferenced candidate described above.
        }
      } catch (error) {
        try {
          await deleteUnusedCandidateUser(db, candidateUserId);
        } catch {
          // A crash or cleanup failure can leave only the same benign unreferenced candidate described above.
        }
        throw error;
      }
    }

    throw new Error("OpenAuth user identity could not be allocated.");
  },
});

const createEmailCodeDelivery = (
  kv: KVNamespace,
  email: TransactionalEmailBinding,
  from: string,
): OpenAuthCodeDelivery => ({
  async sendCode({ address, code }) {
    const normalizedAddress = normalizeCodeAddress(address);
    if (!normalizedAddress || normalizedAddress !== address) {
      throw new TypeError("OpenAuth code address must be normalized.");
    }

    const cooldownKey = await hashCooldownKey(normalizedAddress);
    if (await kv.get(cooldownKey)) throw new CodeEmailCooldownError();

    await kv.put(cooldownKey, "1", { expirationTtl: CODE_EMAIL_COOLDOWN_SECONDS });
    const safeCode = escapeHtml(code);
    try {
      await email.send({
        to: normalizedAddress,
        from,
        subject: "Your Nulldown verification code",
        text: `Your Nulldown verification code is ${code}. It expires when this sign-in session expires.`,
        html: `<p>Your Nulldown verification code is <strong>${safeCode}</strong>.</p><p>It expires when this sign-in session expires.</p>`,
      });
    } catch (error) {
      try {
        await kv.delete(cooldownKey);
      } catch {
        // A failed deletion leaves only a short-lived cooldown and never exposes the address or code.
      }
      throw error;
    }
  },
});

const codeEmailCooldownResponse = async (
  request: Request,
  kv: KVNamespace,
): Promise<Response | null> => {
  const url = new URL(request.url);
  if (request.method !== "POST" || url.pathname !== "/code/authorize") return null;

  let form: FormData;
  try {
    form = await request.clone().formData();
  } catch {
    return null;
  }

  const action = form.get("action")?.toString();
  if (action !== "request" && action !== "resend") return null;

  const address = normalizeCodeAddress(form.get("address"));
  if (!address) return null;

  if (await kv.get(await hashCooldownKey(address))) {
    return new Response("Too many verification code requests. Please wait before trying again.", {
      status: 429,
      headers: { "Cache-Control": "no-store" },
    });
  }
  return null;
};

/** Native Cloudflare bindings required by the OpenAuth issuer. */
export interface NulldownOpenAuthWorkerEnvironment {
  /** Durable OpenAuth storage. Memory storage is intentionally unavailable here. */
  OPENAUTH_KV?: KVNamespace;
  /** Shared application D1 database containing only additive OpenAuth principal tables. */
  DB?: D1Database;
  /** Native Cloudflare Email Sending binding for transactional verification codes. */
  EMAIL?: TransactionalEmailBinding;
  /** Exact canonical HTTPS origin used by this issuer. */
  OPENAUTH_ISSUER_URL?: string;
  /** Verified transactional sender address for verification messages. */
  OPENAUTH_EMAIL_FROM?: string;
  /** JSON array of exact `{ clientId, redirectUri }` browser registrations. */
  OPENAUTH_CLIENTS_JSON?: string;
}

const unavailable = (reason: string) =>
  new Response(`OpenAuth service unavailable: ${reason}`, {
    status: 503,
    headers: { "Cache-Control": "no-store" },
  });

const cacheResponse = (request: Request, response: Response): Response => {
  const url = new URL(request.url);
  const cacheSeconds =
    request.method === "GET" &&
    response.status === 200 &&
    !request.url.includes("?") &&
    url.pathname === DISCOVERY_PATH
      ? 3600
      : null;
  const headers = new Headers(response.headers);
  headers.set(
    "Cache-Control",
    cacheSeconds === null ? "no-store" : `public, max-age=${cacheSeconds}`,
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

const parseClients = (value: string | undefined) => {
  if (!value) return null;

  try {
    return parseOpenAuthClientRegistrations(JSON.parse(value));
  } catch {
    return null;
  }
};

/** Handles the production Worker request without substituting test-only dependencies. */
export const fetchOpenAuthWorker = async (
  request: Request,
  env: NulldownOpenAuthWorkerEnvironment,
): Promise<Response> => {
  if (!isKvNamespace(env.OPENAUTH_KV)) {
    return unavailable("storage_binding_unavailable");
  }

  if (!isD1Database(env.DB)) {
    return unavailable("principal_store_unavailable");
  }

  if (!env.EMAIL || typeof env.EMAIL.send !== "function") {
    return unavailable("email_binding_unavailable");
  }

  const issuer = normalizeIssuerOrigin(env.OPENAUTH_ISSUER_URL);
  if (!issuer || issuer !== new URL(request.url).origin) {
    return unavailable("issuer_configuration_invalid");
  }

  const emailFrom = normalizeCodeAddress(env.OPENAUTH_EMAIL_FROM);
  if (!emailFrom) {
    return unavailable("email_sender_configuration_invalid");
  }

  const clients = parseClients(env.OPENAUTH_CLIENTS_JSON);
  if (!clients) {
    return unavailable("client_configuration_invalid");
  }

  const app = createNulldownOpenAuthApplication({
    // OpenAuth's pinned Workers type declaration is older than this workspace's.
    storage: CloudflareStorage({
      namespace: env.OPENAUTH_KV as Parameters<typeof CloudflareStorage>[0]["namespace"],
    }),
    codeDelivery: createEmailCodeDelivery(env.OPENAUTH_KV, env.EMAIL, emailFrom),
    userIdResolver: createD1UserIdResolver(env.DB, issuer),
    clients,
  });

  try {
    const cooldown = await codeEmailCooldownResponse(request, env.OPENAUTH_KV);
    if (cooldown) return cooldown;
    return cacheResponse(request, await app.fetch(request));
  } catch (error) {
    if (error instanceof CodeEmailCooldownError) {
      return new Response("Too many verification code requests. Please wait before trying again.", {
        status: 429,
        headers: { "Cache-Control": "no-store" },
      });
    }
    return unavailable("request_unavailable");
  }
};

export default {
  fetch: fetchOpenAuthWorker,
} satisfies ExportedHandler<NulldownOpenAuthWorkerEnvironment>;

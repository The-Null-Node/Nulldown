import { CloudflareStorage } from "@openauthjs/openauth/storage/cloudflare";

import {
  createNulldownOpenAuthApplication,
  parseOpenAuthClientRegistrations,
  type NulldownUserIdResolver,
  type OpenAuthCodeDelivery,
} from "./application";

/** Cloudflare Worker bindings required by the OpenAuth foundation. */
export interface NulldownOpenAuthWorkerEnvironment {
  /** Durable OpenAuth storage. Memory storage is intentionally unavailable here. */
  OPENAUTH_KV?: KVNamespace;
  /** Service binding or adapter that delivers one-time codes. */
  OPENAUTH_CODE_DELIVERY?: OpenAuthCodeDelivery;
  /** Application-owned identity resolver service binding. */
  OPENAUTH_IDENTITY_RESOLVER?: NulldownUserIdResolver;
  /** JSON array of exact `{ clientId, redirectUri }` browser registrations. */
  OPENAUTH_CLIENTS_JSON?: string;
}

const unavailable = (reason: string) =>
  new Response(`OpenAuth service unavailable: ${reason}`, { status: 503 });

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
  if (!env.OPENAUTH_KV) {
    return unavailable("required OPENAUTH_KV KV binding is missing.");
  }

  if (!env.OPENAUTH_CODE_DELIVERY) {
    return unavailable("required OPENAUTH_CODE_DELIVERY binding is missing.");
  }

  if (!env.OPENAUTH_IDENTITY_RESOLVER) {
    return unavailable("required OPENAUTH_IDENTITY_RESOLVER binding is missing.");
  }

  const clients = parseClients(env.OPENAUTH_CLIENTS_JSON);
  if (!clients) {
    return unavailable("required exact OPENAUTH_CLIENTS_JSON configuration is missing or invalid.");
  }

  const app = createNulldownOpenAuthApplication({
    // OpenAuth's pinned Workers type declaration is older than this workspace's.
    storage: CloudflareStorage({
      namespace: env.OPENAUTH_KV as Parameters<typeof CloudflareStorage>[0]["namespace"],
    }),
    codeDelivery: env.OPENAUTH_CODE_DELIVERY,
    userIdResolver: env.OPENAUTH_IDENTITY_RESOLVER,
    clients,
  });

  return app.fetch(request);
};

export default {
  fetch: fetchOpenAuthWorker,
} satisfies ExportedHandler<NulldownOpenAuthWorkerEnvironment>;

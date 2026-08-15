import { issuer } from "@openauthjs/openauth";
import type {
  Provider,
  ProviderOptions,
  ProviderRoute,
} from "@openauthjs/openauth/provider/provider";
import { createSubjects } from "@openauthjs/openauth/subject";
import type { StorageAdapter } from "@openauthjs/openauth/storage/storage";
import { literal, object, string } from "valibot";

import {
  NULDOWN_USER_SUBJECT_TYPE,
  NULDOWN_USER_SUBJECT_VERSION_V1,
  createNulldownUserSubject,
} from "../../../shared/auth/subjects";

const ADDRESS_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{2,127}$/u;
const STATE_PATTERN = /^[A-Za-z0-9_-]{16,512}$/u;
const PKCE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43,128}$/u;

type CodeProviderState =
  | { type: "start" }
  | {
      type: "code";
      resend?: boolean;
      code: string;
      claims: Record<string, string>;
    };

type CodeProviderError =
  | { type: "invalid_code" }
  | { type: "invalid_claim"; key: string; value: string };

interface WorkerCodeProviderConfig<Claims extends Record<string, string>> {
  request: (
    request: Request,
    state: CodeProviderState,
    form?: FormData,
    error?: CodeProviderError,
  ) => Promise<Response>;
  sendCode: (claims: Claims, code: string) => Promise<void | CodeProviderError>;
}

const generateCode = (length: number): string => {
  const bytes = new Uint8Array(length);
  let code = "";

  for (let index = 0; index < length; index += 1) {
    do {
      crypto.getRandomValues(bytes.subarray(index, index + 1));
    } while (bytes[index] >= 250);

    code += (bytes[index] % 10).toString();
  }

  return code;
};

const codesMatch = (expected: string, submitted: string): boolean => {
  let difference = expected.length ^ submitted.length;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected.charCodeAt(index) ^ (submitted.charCodeAt(index) || 0);
  }

  return difference === 0;
};

/* OpenAuth 0.4.3's CodeProvider imports node:crypto. This preserves its flow with Web Crypto. */
const WorkerCodeProvider = <Claims extends Record<string, string>>(
  config: WorkerCodeProviderConfig<Claims>,
): Provider<{ claims: Claims }> => ({
  type: "code",
  init(routes: ProviderRoute, context: ProviderOptions<{ claims: Claims }>) {
    const transition = async (
      requestContext: Parameters<ProviderOptions<{ claims: Claims }>["success"]>[0],
      state: CodeProviderState,
      form?: FormData,
      error?: CodeProviderError,
    ): Promise<Response> => {
      await context.set(requestContext, "provider", 60 * 60 * 24, state);
      return context.forward(
        requestContext,
        await config.request(requestContext.req.raw, state, form, error),
      );
    };

    routes.get("/authorize", (requestContext) =>
      transition(requestContext, { type: "start" }),
    );
    routes.post("/authorize", async (requestContext) => {
      const form = await requestContext.req.formData();
      const state = await context.get<CodeProviderState>(requestContext, "provider");
      const action = form.get("action")?.toString();

      if (action === "request" || action === "resend") {
        const claims = Object.fromEntries(form) as Claims;
        delete claims.action;
        const code = generateCode(6);
        const error = await config.sendCode(claims, code);
        if (error) return transition(requestContext, { type: "start" }, form, error);

        return transition(
          requestContext,
          { type: "code", resend: action === "resend", claims, code },
          form,
        );
      }

      if (action === "verify" && state?.type === "code") {
        const submitted = form.get("code")?.toString() ?? "";
        if (!codesMatch(state.code, submitted)) {
          return transition(
            requestContext,
            { ...state, resend: false },
            form,
            { type: "invalid_code" },
          );
        }

        await context.unset(requestContext, "provider");
        return context.forward(
          requestContext,
          await context.success(requestContext, { claims: state.claims as Claims }),
        );
      }

      return transition(requestContext, { type: "start" }, form, { type: "invalid_code" });
    });
  },
});

/** OpenAuth subject schemas shared by the issuer and downstream token verifiers. */
export const nulldownOpenAuthSubjects = createSubjects({
  [NULDOWN_USER_SUBJECT_TYPE]: object({
    version: literal(NULDOWN_USER_SUBJECT_VERSION_V1),
    userId: string(),
  }),
});

/** One exact browser client and callback URL accepted by the authorization endpoint. */
export interface OpenAuthClientRegistration {
  /** Public OAuth client identifier. */
  clientId: string;
  /** Exact HTTPS redirect URI, including path and any static query. */
  redirectUri: string;
}

/** Delivery port for a one-time code after the CodeProvider validates its claim. */
export interface OpenAuthCodeDelivery {
  /** Delivers one code to a normalized address. */
  sendCode(input: Readonly<{ address: string; code: string }>): Promise<void>;
}

/** Application-owned mapping from a verified provider claim to a stable user id. */
export interface NulldownUserIdResolver {
  /** Resolves a stable user id; user and identity persistence belong to the application adapter. */
  resolveUserId(input: Readonly<{ address: string }>): Promise<string>;
}

/** Dependencies for a provider-neutral OpenAuth issuer instance. */
export interface NulldownOpenAuthApplicationOptions {
  /** Persistent OpenAuth state storage. Tests may inject MemoryStorage. */
  storage: StorageAdapter;
  /** Controlled delivery adapter. The worker package does not send email itself. */
  codeDelivery: OpenAuthCodeDelivery;
  /** Application-owned user identity mapping. */
  userIdResolver: NulldownUserIdResolver;
  /** Explicit browser client registrations. Wildcards and hostname matching are not supported. */
  clients: readonly OpenAuthClientRegistration[];
}

/** Minimal Fetch surface exposed by the provider-neutral issuer factory. */
export interface NulldownOpenAuthApplication {
  /** Handles a single OpenAuth request. */
  fetch(request: Request): Promise<Response>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeRedirectUri = (value: unknown): string | null => {
  if (typeof value !== "string") return null;

  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      url.toString() !== value
    ) {
      return null;
    }

    return url.toString();
  } catch {
    return null;
  }
};

/** Parses explicit client registrations and rejects non-canonical or duplicate entries. */
export const parseOpenAuthClientRegistrations = (
  value: unknown,
): OpenAuthClientRegistration[] | null => {
  if (!Array.isArray(value) || value.length === 0) return null;

  const parsed: OpenAuthClientRegistration[] = [];
  const clientIds = new Set<string>();

  for (const entry of value) {
    if (!isRecord(entry) || Object.keys(entry).length !== 2) return null;
    if (typeof entry.clientId !== "string" || !CLIENT_ID_PATTERN.test(entry.clientId)) {
      return null;
    }

    const redirectUri = normalizeRedirectUri(entry.redirectUri);
    if (!redirectUri || clientIds.has(entry.clientId)) return null;

    clientIds.add(entry.clientId);
    parsed.push({ clientId: entry.clientId, redirectUri });
  }

  return parsed;
};

/** Normalizes one code-provider address before delivery and identity resolution. */
export const normalizeCodeAddress = (value: unknown): string | null => {
  if (typeof value !== "string") return null;

  const address = value.trim().normalize("NFC").toLowerCase();
  if (address.length > 254 || !ADDRESS_PATTERN.test(address)) return null;

  return address;
};

const createCodeUi = async (
  _request: Request,
  state: CodeProviderState,
  _form?: FormData,
  error?: CodeProviderError,
): Promise<Response> => {
  const message = error ? "The submitted value was not accepted." : "";
  const body =
    state.type === "start"
      ? `<form method="post"><label>Address <input name="address" autocomplete="email" required></label><button name="action" value="request">Continue</button><p>${message}</p></form>`
      : `<form method="post"><label>Code <input name="code" inputmode="numeric" required></label><button name="action" value="verify">Verify</button><p>${message}</p></form>`;

  return new Response(body, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
};

const validateAuthorizationRequest = (
  request: Request,
  clients: readonly OpenAuthClientRegistration[],
): Response | null => {
  const url = new URL(request.url);
  if (url.pathname !== "/authorize") return null;

  const responseType = url.searchParams.get("response_type");
  const clientId = url.searchParams.get("client_id");
  const redirectUri = normalizeRedirectUri(url.searchParams.get("redirect_uri"));
  const state = url.searchParams.get("state");
  const codeChallenge = url.searchParams.get("code_challenge");
  const codeChallengeMethod = url.searchParams.get("code_challenge_method");

  if (
    responseType !== "code" ||
    !state ||
    !STATE_PATTERN.test(state) ||
    !codeChallenge ||
    !PKCE_CHALLENGE_PATTERN.test(codeChallenge) ||
    codeChallengeMethod !== "S256"
  ) {
    return new Response("Authorization requires state and S256 PKCE.", { status: 400 });
  }

  const allowed = clients.some(
    (client) => client.clientId === clientId && client.redirectUri === redirectUri,
  );
  return allowed
    ? null
    : new Response("OpenAuth client or redirect URI is not allowed.", { status: 403 });
};

/** Creates an isolated authorization-code-and-PKCE OpenAuth issuer. */
export const createNulldownOpenAuthApplication = (
  options: NulldownOpenAuthApplicationOptions,
): NulldownOpenAuthApplication => {
  const clients = parseOpenAuthClientRegistrations(options.clients);
  if (!clients) {
    throw new TypeError("OpenAuth requires at least one exact client registration.");
  }

  const app = issuer({
    storage: options.storage,
    subjects: nulldownOpenAuthSubjects,
    providers: {
      code: WorkerCodeProvider<{ address: string }>({
        request: createCodeUi,
        sendCode: async (claims, code) => {
          const address = normalizeCodeAddress(claims.address);
          if (!address) {
            return {
              type: "invalid_claim",
              key: "address",
              value: typeof claims.address === "string" ? claims.address : "",
            };
          }

          await options.codeDelivery.sendCode({ address, code });
        },
      }),
    },
    allow: async (input) =>
      clients.some(
        (client) =>
          client.clientId === input.clientID && client.redirectUri === input.redirectURI,
      ),
    success: async (response, result) => {
      const address = normalizeCodeAddress(result.claims.address);
      if (!address) {
        throw new TypeError("Verified code flow did not contain a valid address.");
      }

      const userId = await options.userIdResolver.resolveUserId({ address });
      return response.subject(
        NULDOWN_USER_SUBJECT_TYPE,
        createNulldownUserSubject(userId),
      );
    },
  });

  return {
    async fetch(request) {
      const rejection = validateAuthorizationRequest(request, clients);
      return rejection ?? app.fetch(request);
    },
  };
};

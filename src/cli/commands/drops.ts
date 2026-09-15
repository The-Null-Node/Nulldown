import { flagString, hasFlag } from "../core/args";
import type { ParsedArgs } from "../core/args";
import type { CliCommand } from "../core/command";
import type { NulldownRuntime } from "../runtime/types";
import type { CliCredentialBundleV1 } from "../../../shared/auth/cliDevice";
import { sealDropForAuthoring } from "../../../shared/drop/authoringCrypto";
import { isDropEncryptionPublicJwk } from "../../../shared/drop/deviceDelegation";
import type { DropEnvelopeV1, DropVisibility } from "../../../shared/drop/types";
import {
  buildSeedCreateOutput,
  buildSeedDropContent,
  buildSeedDropMetadata,
  formatSeedHuman,
  isSeedCreateArgs,
  resolveSeedTitle,
} from "../seed";

const parseLabels = (args: ParsedArgs): string[] =>
  flagString(args, "labels")
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean) ?? [];

const getDropMetadata = (body: unknown): Record<string, unknown> | undefined =>
  body && typeof body === "object" && !Array.isArray(body) && "metadata" in body
    ? ((body as { metadata?: unknown }).metadata as Record<string, unknown> | undefined)
    : undefined;

const AUTHORING_REENROLL_MESSAGE =
  "Run nd auth login again to enable account-owned authoring.";

const LEGACY_PLAINTEXT_WARNING =
  "warning: --legacy-plaintext stores an authenticated plaintext drop and it will not enter Remote Library.";

interface DropAuthoringConfig {
  token?: string | null;
  authCredential?: CliCredentialBundleV1 | null;
}

const resolveVisibility = (args: ParsedArgs): DropVisibility => {
  const visibility = flagString(args, "visibility") ?? "unlisted";
  if (visibility === "private" || visibility === "unlisted" || visibility === "public") {
    return visibility;
  }
  throw new Error("--visibility must be private, unlisted, or public.");
};

const importEncryptionKey = async (jwk: JsonWebKey): Promise<CryptoKey> =>
  await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"],
  );

const getProviderEncryption = async (): Promise<
  { kid: string; publicKey: CryptoKey } | undefined
> => {
  const raw = process.env.VITE_PROVIDER_ENCRYPTION_PUBLIC_JWK;
  if (!raw) {
    throw new Error(
      "Provider unlock policy requires VITE_PROVIDER_ENCRYPTION_PUBLIC_JWK.",
    );
  }
  let jwk: JsonWebKey;
  try {
    jwk = JSON.parse(raw) as JsonWebKey;
  } catch {
    throw new Error("VITE_PROVIDER_ENCRYPTION_PUBLIC_JWK must contain a public RSA JWK.");
  }
  if (!isDropEncryptionPublicJwk(jwk)) {
    throw new Error("VITE_PROVIDER_ENCRYPTION_PUBLIC_JWK must contain a public RSA JWK.");
  }
  const source = jwk as Record<string, unknown>;
  return {
    kid: typeof source.kid === "string" ? source.kid : "provider",
    publicKey: await importEncryptionKey(jwk),
  };
};

const sealAccountDrop = async (
  credential: CliCredentialBundleV1 | null | undefined,
  content: string,
  metadata: Record<string, unknown>,
  visibility: DropVisibility,
): Promise<DropEnvelopeV1> => {
  const authoring = credential?.authoring;
  if (!credential || !authoring) throw new Error(AUTHORING_REENROLL_MESSAGE);
  const accountEncryption = authoring.deviceDelegation.encryptionPublicJwk;
  if (!isDropEncryptionPublicJwk(accountEncryption)) {
    throw new Error(AUTHORING_REENROLL_MESSAGE);
  }
  const [encryptionPublicKey, signingPrivateKey, providerEncryption] = await Promise.all([
    importEncryptionKey(accountEncryption),
    crypto.subtle.importKey(
      "jwk",
      authoring.signingPrivateJwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    ),
    visibility === "private" ? Promise.resolve(undefined) : getProviderEncryption(),
  ]);
  return await sealDropForAuthoring({
    payload: { content, metadata },
    accountEncryption: {
      accountId: credential.accountId,
      encryptionKid: authoring.deviceDelegation.encryptionKid,
      encryptionPublicJwk: accountEncryption,
      encryptionPublicKey,
    },
    delegateSigning: {
      signingKid: authoring.signingKid,
      signingPublicJwk: authoring.signingPublicJwk,
      signingPrivateKey,
      deviceDelegation: authoring.deviceDelegation,
    },
    providerEncryption,
    visibility,
    unlockPolicy: visibility === "private" ? "vault-only" : "provider-escrow",
    metadata,
  });
};

/** Dependencies used by modular drop read commands. */
export interface DropCommandDependencies {
  /** Runtime facade for drop operations. */
  runtime: NulldownRuntime;
  /** Prints command output using the active CLI output policy. */
  print(value: unknown, human?: string): void;
  /** Redacts sensitive fields before human JSON rendering. */
  redact(value: unknown): unknown;
  /** Writes raw text output. */
  writeText(text: string): void;
  /** Reads command input from a file path or stdin marker. */
  readInput(path: string | null): Promise<string>;
  /** Parses metadata flags using the active CLI input policy. */
  parseMetadata(args: ParsedArgs): Promise<Record<string, unknown> | undefined>;
  /** Returns whether seed creation should auto-resolve a branch. */
  shouldResolveSeedBranch(): boolean;
}

/** Creates modular drop commands. */
export const createDropCommands = <TConfig extends DropAuthoringConfig>(
  dependencies: DropCommandDependencies,
): CliCommand<TConfig>[] => [
  {
    name: "create",
    async run({ config, args }) {
      const seed = isSeedCreateArgs(args);
      const source = args.positionals[1] ?? "-";
      const metadataOverride = await dependencies.parseMetadata(args);
      const labels = parseLabels(args);
      const content = seed
        ? buildSeedDropContent({
            title: resolveSeedTitle(args),
            intent: flagString(args, "intent"),
            labels,
          })
        : await dependencies.readInput(source);
      const metadata = seed
        ? buildSeedDropMetadata(labels, metadataOverride)
        : (metadataOverride ?? { themeId: "system" });
      const legacyPlaintext = hasFlag(args, "legacy-plaintext");
      if (legacyPlaintext && config.token) console.error(LEGACY_PLAINTEXT_WARNING);
      const envelope = config.token && !legacyPlaintext
        ? await sealAccountDrop(config.authCredential, content, metadata, resolveVisibility(args))
        : undefined;
      const drop = await dependencies.runtime.drops.create({ content, metadata, envelope });
      if (!seed) {
        dependencies.print(drop, `created ${drop.url}`);
        return;
      }

      let branch: unknown;
      let branchResolveError: string | null = null;
      const forceResolve = hasFlag(args, "resolve-branch");
      const shouldResolve =
        forceResolve ||
        (!hasFlag(args, "no-resolve-branch") && dependencies.shouldResolveSeedBranch());
      if (shouldResolve) {
        try {
          branch = await dependencies.runtime.branches.resolve(drop.id);
        } catch (error) {
          if (forceResolve) throw error;
          branchResolveError = error instanceof Error ? error.message : String(error);
        }
      }

      const output = buildSeedCreateOutput({
        drop,
        branch,
        branchResolveError,
      });
      dependencies.print(output, formatSeedHuman(output));
    },
  },
  {
    name: "update",
    async run({ config, args }) {
      const id = args.positionals[1];
      const source = args.positionals[2] ?? "-";
      if (!id) throw new Error("Usage: nd update <id> <file|->");
      const current = await dependencies.runtime.drops.get(id);
      const content = await dependencies.readInput(source);
      const metadataOverride = await dependencies.parseMetadata(args);
      const currentMetadata = getDropMetadata(current.body);
      const metadata = metadataOverride
        ? { ...(currentMetadata ?? {}), ...metadataOverride }
        : (currentMetadata ?? { themeId: "system" });
      const legacyPlaintext = hasFlag(args, "legacy-plaintext");
      if (legacyPlaintext && config.token) console.error(LEGACY_PLAINTEXT_WARNING);
      const envelope = config.token && !legacyPlaintext
        ? await sealAccountDrop(config.authCredential, content, metadata, resolveVisibility(args))
        : undefined;
      const response = await dependencies.runtime.drops.update({
        id: current.id,
        content,
        metadata,
        expectedRevision: hasFlag(args, "force") ? null : current.revision,
        envelope,
      });
      dependencies.print(response, `updated ${response.url}`);
    },
  },
  {
    name: "get",
    async run({ args }) {
      const id = args.positionals[1];
      if (!id) throw new Error("Usage: nd get <id>");
      const drop = await dependencies.runtime.drops.get(id);
      if (hasFlag(args, "raw")) {
        if (drop.body && typeof drop.body === "object" && "content" in drop.body) {
          dependencies.writeText(String((drop.body as { content: unknown }).content));
          return;
        }
        dependencies.writeText(drop.text);
        return;
      }
      dependencies.print(
        drop,
        typeof drop.body === "string"
          ? drop.body
          : JSON.stringify(dependencies.redact(drop.body), null, 2),
      );
    },
  },
  {
    name: "list",
    async run({ args }) {
      const response = await dependencies.runtime.drops.list({
        limit: flagString(args, "limit"),
        cursor: flagString(args, "cursor"),
      });
      dependencies.print(response);
    },
  },
  {
    name: "delete",
    async run({ args }) {
      const id = args.positionals[1];
      if (!id) throw new Error("Usage: nd delete <id>");
      const response = await dependencies.runtime.drops.delete(id, {
        force: hasFlag(args, "force"),
      });
      dependencies.print(response, `deleted ${id}`);
    },
  },
  {
    name: "search",
    async run({ args }) {
      const response = await dependencies.runtime.drops.search({
        query: args.positionals[1] ?? flagString(args, "query"),
        owner: flagString(args, "owner"),
        visibility: flagString(args, "visibility"),
        limit: flagString(args, "limit"),
        offset: flagString(args, "offset"),
      });
      dependencies.print(response);
    },
  },
];

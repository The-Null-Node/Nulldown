import { randomUUID } from "node:crypto";
import {
  diffToDropDiffOp,
  type DropDiffEnvelope,
  type DropDiffEventMetadata,
  type DropDiffOp,
} from "../../../shared/drop/diff";
import {
  DIFF_CLIENT_ID_HEADER,
  DIFF_SECRET_KID_HEADER,
  DIFF_SIGNATURE_HEADER,
  DIFF_TIMESTAMP_HEADER,
  type DiffAuthRegisterResponse,
} from "../../../shared/drop/diffAuth";
import { DropDiffEventIdSchema } from "../../../shared/drop/diffSchemas";
import { computeDiffOps } from "../../../shared/nulledit/textDiff";
import { flagString, hasFlag, type ParsedArgs } from "../core/args";
import type { CliCommand } from "../core/command";
import type { DropReadResult, NulldownRuntime } from "../runtime/types";

const DIFF_RUNTIME_SUBCOMMANDS = new Set([
  "poll",
  "latest",
  "event",
  "batch",
  "apply",
  "replace",
  "keygen",
  "register",
  "sign",
  "token",
]);

/** Stored diff client keypair record. */
export interface DiffClientKeysRecord {
  version: 1;
  clientId: string;
  createdAt: number;
  encryptionPublicJwk: JsonWebKey;
  encryptionPrivateJwk: JsonWebKey;
}

/** Stored per-drop diff credential. */
export interface DiffCredentialEntry {
  version: 1;
  dropId: string;
  branchId: string;
  baseUrl: string;
  clientId: string;
  kid: string;
  secret: string;
  createdAt: number;
  expiresAt: number | null;
}

/** Stored diff auth token bundle. */
export interface DiffAuthTokenBundle {
  version: 1;
  kind: "nulldown.diff-auth.v1";
  createdAt: number;
  keys: DiffClientKeysRecord | null;
  credentials: Record<string, DiffCredentialEntry>;
}

const getDropContent = (drop: DropReadResult): string => {
  if (drop.body && typeof drop.body === "object" && "content" in drop.body) {
    return String((drop.body as { content: unknown }).content);
  }

  return drop.text;
};

const branchContentFromResponse = (
  value: unknown,
  fallbackRootDropId: string,
): { rootDropId: string; content: string; headEventSeq: number | null } | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as {
    rootDropId?: unknown;
    content?: unknown;
    headEventSeq?: unknown;
  };
  if (typeof record.content !== "string") return null;
  if (
    record.headEventSeq !== undefined &&
    record.headEventSeq !== null &&
    (!Number.isInteger(record.headEventSeq) || record.headEventSeq < -1)
  ) {
    throw new Error("Branch content response contains an invalid head event cursor.");
  }
  return {
    rootDropId:
      typeof record.rootDropId === "string" && record.rootDropId
        ? record.rootDropId
        : fallbackRootDropId,
    content: record.content,
    headEventSeq:
      typeof record.headEventSeq === "number" ? record.headEventSeq : null,
  };
};

const parsePosition = (value: string): { start: number; text: string } => {
  const separator = value.indexOf(":");
  if (separator === -1) throw new Error("Expected insert format pos:text.");
  const start = Number.parseInt(value.slice(0, separator), 10);
  if (!Number.isFinite(start) || start < 0) {
    throw new Error("Insert position must be >= 0.");
  }
  return { start, text: value.slice(separator + 1) };
};

const parseRange = (value: string): { start: number; end: number } => {
  const [rawStart, rawEnd] = value.split(":");
  const start = Number.parseInt(rawStart || "", 10);
  const end = Number.parseInt(rawEnd || "", 10);
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end < start
  ) {
    throw new Error("Expected delete format start:end with end >= start.");
  }
  return { start, end };
};

const createEvent = (input: {
  dropId: string;
  clientId: string;
  ops: DropDiffOp[];
  metadata?: DropDiffEventMetadata;
  eventId?: string;
  createdAt?: number;
}): DropDiffEnvelope => ({
  version: 1,
  events: [
    {
      eventId: input.eventId ?? `nd-${Date.now()}-${randomUUID()}`,
      seq: 0,
      dropId: input.dropId,
      sourceClientId: input.clientId,
      createdAt: input.createdAt ?? Date.now(),
      ops: input.ops,
      metadata: input.metadata,
    },
  ],
});

const eventIdentityFromArgs = (
  args: ParsedArgs,
): Pick<DropDiffEnvelope["events"][number], "eventId" | "createdAt"> | undefined => {
  const hasEventId = Object.hasOwn(args.flags, "event-id");
  const hasCreatedAt = Object.hasOwn(args.flags, "created-at");
  const eventId = flagString(args, "event-id");
  const createdAtRaw = flagString(args, "created-at");
  if (hasEventId !== hasCreatedAt) {
    throw new Error("Provide --event-id and --created-at together when retrying a diff.");
  }
  if (!hasEventId) return undefined;
  if (eventId === null || createdAtRaw === null) {
    throw new Error("--event-id and --created-at require values.");
  }
  if (!DropDiffEventIdSchema.safeParse(eventId).success) {
    throw new Error("--event-id must be 1-120 characters without surrounding whitespace.");
  }
  const createdAt = Number(createdAtRaw);
  if (!createdAtRaw.trim() || !Number.isInteger(createdAt) || createdAt < 0) {
    throw new Error("--created-at must be a non-negative integer.");
  }
  return { eventId, createdAt };
};

const branchIdFromPosted = (posted: unknown, fallbackBranchId: string): string => {
  if (posted && typeof posted === "object" && !Array.isArray(posted)) {
    const branchId = (posted as { branchId?: unknown }).branchId;
    if (typeof branchId === "string" && branchId) return branchId;
  }
  return fallbackBranchId;
};

/** Dependencies used by modular diff commands. */
export interface DiffCommandDependencies {
  /** Runtime facade for diff operations. */
  runtime: NulldownRuntime;
  /** Prints command output using the active CLI output policy. */
  print(value: unknown, human?: string): void;
  /** Parses a prebuilt diff envelope from command input. */
  parseDiffEnvelopeInput(args: ParsedArgs): Promise<DropDiffEnvelope>;
  /** Parses diff event metadata flags. */
  parseDiffEventMetadata(args: ParsedArgs): Promise<DropDiffEventMetadata | undefined>;
  /** Reads command input from a file path or stdin marker. */
  readInput(path: string | null): Promise<string>;
  /** Returns the configured client id, if any. */
  clientId(): string | null;
  /** Reads the local diff auth token bundle. */
  readDiffAuthBundle(): Promise<DiffAuthTokenBundle>;
  /** Writes the local diff auth token bundle. */
  writeDiffAuthBundle(bundle: DiffAuthTokenBundle): Promise<void>;
  /** Merges an imported token bundle into an existing bundle. */
  mergeDiffAuthBundles(
    current: DiffAuthTokenBundle,
    incoming: DiffAuthTokenBundle,
    overwriteKeys: boolean,
  ): DiffAuthTokenBundle;
  /** Encodes a token bundle for export. */
  encodeDiffAuthToken(bundle: DiffAuthTokenBundle): string;
  /** Decodes an imported token bundle. */
  decodeDiffAuthToken(token: string): DiffAuthTokenBundle;
  /** Registers a drop for diff auth using the supplied keypair. */
  registerDiffAuth(
    dropId: string,
    keys: DiffClientKeysRecord,
  ): Promise<DiffAuthRegisterResponse>;
  /** Decrypts a wrapped diff auth shared secret. */
  unwrapSecret(wrappedSecretBase64: string, privateJwk: JsonWebKey): Promise<string>;
  /** Persists a registered diff credential. */
  writeCredential(entry: DiffCredentialEntry): Promise<void>;
  /** Finds a registered diff credential. */
  findCredential(dropId: string): Promise<DiffCredentialEntry | null>;
  /** Signs a diff request body. */
  signDiffPayload(
    secret: string,
    method: string,
    path: string,
    timestamp: string,
    body: string,
  ): string;
  /** Returns the configured diff auth token path. */
  diffAuthTokenPath(): string;
  /** Returns the configured API base URL. */
  baseUrl(): string;
  /** Writes raw command output without redaction. */
  writeText(text: string): void;
  /** Returns whether the CLI is in JSON output mode. */
  isJson(): boolean;
}

const diffSubcommand = (args: ParsedArgs): string => args.positionals[1] || "";

/** Creates the modular diff command for migrated diff subcommands. */
export const createDiffCommand = <TConfig>(
  dependencies: DiffCommandDependencies,
): CliCommand<TConfig> => ({
  name: "diff",
  async run({ args }) {
    const subcommand = diffSubcommand(args);
    if (!DIFF_RUNTIME_SUBCOMMANDS.has(subcommand)) {
      throw new Error(
        "Usage: nd diff <poll|latest|apply|replace|batch|event|keygen|register|sign|token> ...",
      );
    }

    if (subcommand === "keygen") {
      const bundle = await dependencies.readDiffAuthBundle();
      const tokenPath = dependencies.diffAuthTokenPath();
      if (bundle.keys && !hasFlag(args, "force")) {
        dependencies.print(
          { path: tokenPath, clientId: bundle.keys.clientId },
          `diff auth token already has keys at ${tokenPath}`,
        );
        return;
      }
      const pair = (await crypto.subtle.generateKey(
        {
          name: "RSA-OAEP",
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: "SHA-256",
        },
        true,
        ["encrypt", "decrypt"],
      )) as CryptoKeyPair;
      const record: DiffClientKeysRecord = {
        version: 1,
        clientId:
          flagString(args, "client") ||
          dependencies.clientId() ||
          `client_${randomUUID()}`,
        createdAt: Date.now(),
        encryptionPublicJwk: await crypto.subtle.exportKey("jwk", pair.publicKey),
        encryptionPrivateJwk: await crypto.subtle.exportKey("jwk", pair.privateKey),
      };
      await dependencies.writeDiffAuthBundle({ ...bundle, keys: record });
      dependencies.print(
        { path: tokenPath, clientId: record.clientId },
        `created diff auth token at ${tokenPath}`,
      );
      return;
    }

    if (subcommand === "register") {
      const dropId =
        args.positionals[2] || flagString(args, "drop") || flagString(args, "id");
      if (!dropId) throw new Error("Usage: nd diff register <dropId>");
      const bundle = await dependencies.readDiffAuthBundle();
      const keys = bundle.keys;
      if (!keys) {
        throw new Error(
          `Missing keypair in ${dependencies.diffAuthTokenPath()}. Run nd diff keygen first.`,
        );
      }
      const response = await dependencies.registerDiffAuth(dropId, keys);
      const secret = await dependencies.unwrapSecret(
        response.wrappedSecret,
        keys.encryptionPrivateJwk,
      );
      const entry: DiffCredentialEntry = {
        version: 1,
        dropId: response.dropId,
        branchId: response.branchId,
        baseUrl: dependencies.baseUrl(),
        clientId: response.clientId,
        kid: response.kid,
        secret,
        createdAt: Date.now(),
        expiresAt: response.expiresAt,
      };
      await dependencies.writeCredential(entry);
      dependencies.print(
        entry,
        `registered diff auth for ${entry.dropId} branch=${entry.branchId}`,
      );
      return;
    }

    if (subcommand === "token") {
      const action = args.positionals[2];
      if (action === "export" || action === "show") {
        const dropId =
          args.positionals[3] || flagString(args, "drop") || flagString(args, "id");
        const bundle = await dependencies.readDiffAuthBundle();
        const credentials = dropId
          ? bundle.credentials[dropId]
            ? { [dropId]: bundle.credentials[dropId] }
            : {}
          : bundle.credentials;
        const exportedBundle: DiffAuthTokenBundle = {
          ...bundle,
          credentials,
        };
        const token = dependencies.encodeDiffAuthToken(exportedBundle);
        if (dependencies.isJson()) {
          dependencies.writeText(
            JSON.stringify({ token, credentialDropIds: Object.keys(credentials) }, null, 2),
          );
        } else {
          dependencies.writeText(token);
        }
        return;
      }

      if (action === "import") {
        const tokenSource = flagString(args, "token") || args.positionals[3];
        const rawToken = tokenSource
          ? tokenSource === "-"
            ? await dependencies.readInput("-")
            : tokenSource
          : await dependencies.readInput(flagString(args, "token-file") || "-");
        const imported = dependencies.decodeDiffAuthToken(rawToken);
        const existing = await dependencies.readDiffAuthBundle();
        const hasExisting = Boolean(
          existing.keys || Object.keys(existing.credentials).length,
        );
        if (hasExisting && !hasFlag(args, "force") && !hasFlag(args, "merge")) {
          throw new Error("Diff auth token already exists. Use --merge or --force.");
        }
        const next = hasFlag(args, "merge")
          ? dependencies.mergeDiffAuthBundles(existing, imported, hasFlag(args, "force"))
          : imported;
        await dependencies.writeDiffAuthBundle(next);
        dependencies.print(
          {
            path: dependencies.diffAuthTokenPath(),
            hasKeys: Boolean(next.keys),
            credentialDropIds: Object.keys(next.credentials),
          },
          `imported diff auth token to ${dependencies.diffAuthTokenPath()}`,
        );
        return;
      }

      throw new Error("Usage: nd diff token <export|import> ...");
    }

    if (subcommand === "sign") {
      const dropId =
        args.positionals[2] || flagString(args, "drop") || flagString(args, "id");
      if (!dropId) {
        throw new Error("Usage: nd diff sign <dropId> --body-file <file|->");
      }
      const body = await dependencies.readInput(
        flagString(args, "body-file") || flagString(args, "body") || "-",
      );
      const credential = await dependencies.findCredential(dropId);
      if (!credential) {
        throw new Error(`No credential for ${dropId}. Run nd diff register ${dropId}.`);
      }
      const timestamp = String(Date.now());
      const path = `/api/diff/${encodeURIComponent(dropId)}`;
      const headers = {
        [DIFF_CLIENT_ID_HEADER]: credential.clientId,
        [DIFF_SECRET_KID_HEADER]: credential.kid,
        [DIFF_TIMESTAMP_HEADER]: timestamp,
        [DIFF_SIGNATURE_HEADER]: dependencies.signDiffPayload(
          credential.secret,
          "POST",
          path,
          timestamp,
          body,
        ),
      };
      dependencies.print(
        { headers },
        Object.entries(headers)
          .map(([key, value]) => `${key}: ${value}`)
          .join("\n"),
      );
      return;
    }

    const dropId =
      args.positionals[2] || flagString(args, "drop") || flagString(args, "id");
    if (!dropId) {
      throw new Error("Usage: nd diff <poll|latest|event|batch> <dropId>");
    }
    const branchId = flagString(args, "branch");

    if (subcommand === "event" || subcommand === "batch") {
      if (subcommand === "batch" && !branchId) {
        throw new Error("nd diff batch requires --branch <branchId>.");
      }
      const envelope = await dependencies.parseDiffEnvelopeInput(args);
      const response = await dependencies.runtime.diffs.postEnvelope({
        dropId,
        branchId,
        envelope,
      });
      dependencies.print(response);
      return;
    }

    if (subcommand === "apply") {
      const eventIdentity = eventIdentityFromArgs(args);
      const canonical = await dependencies.runtime.drops.get(dropId);
      const metadata = await dependencies.parseDiffEventMetadata(args);
      const ops: DropDiffOp[] = [];
      const insert = flagString(args, "insert");
      const del = flagString(args, "delete");
      if (del) {
        const range = parseRange(del);
        ops.push({
          type: "delete",
          start: range.start,
          end: range.end,
          text: "",
        });
      }
      if (insert) {
        const value = parsePosition(insert);
        ops.push({
          type: "insert",
          start: value.start,
          end: value.start,
          text: value.text,
        });
      }
      if (!ops.length) {
        throw new Error("Provide --insert pos:text and/or --delete start:end.");
      }
      const envelope = createEvent({
        dropId: canonical.id,
        clientId: dependencies.clientId() || "nd-cli",
        ops,
        metadata,
        ...eventIdentity,
      });
      const response = await dependencies.runtime.diffs.postEnvelope({
        dropId,
        branchId,
        envelope,
      });
      dependencies.print(response);
      return;
    }

    if (subcommand === "replace") {
      if (!branchId) throw new Error("nd diff replace requires --branch <branchId>.");
      const eventIdentity = eventIdentityFromArgs(args);
      if (eventIdentity) {
        throw new Error(
          "nd diff replace cannot safely replay a generated diff. Save and retry the exact envelope with nd diff event or nd diff batch.",
        );
      }
      const metadata = await dependencies.parseDiffEventMetadata(args);
      const branchContent = branchContentFromResponse(
        await dependencies.runtime.branches.contentOrNull(dropId, branchId),
        dropId,
      );
      const canonical = branchContent ? null : await dependencies.runtime.drops.get(dropId);
      const from = flagString(args, "from-file")
        ? await dependencies.readInput(flagString(args, "from-file"))
        : (branchContent?.content ?? getDropContent(canonical!));
      if (branchContent?.headEventSeq === null) {
        throw new Error(
          "Branch replacement requires a current event cursor. Upgrade the branch server and refresh before retrying.",
        );
      }
      if (branchContent && from !== branchContent.content) {
        throw new Error(
          "Branch replacement --from-file content does not match the current branch. Refresh before retrying.",
        );
      }
      const toFile = flagString(args, "to-file");
      if (!toFile) throw new Error("nd diff replace requires --to-file <file|->.");
      const to = await dependencies.readInput(toFile);
      const diffs = computeDiffOps(from, to);
      if (!diffs.length) {
        dependencies.print({ changed: false }, "no changes");
        return;
      }
      const envelope = createEvent({
        dropId: branchContent?.rootDropId ?? canonical!.id,
        clientId: dependencies.clientId() || "nd-cli",
        ops: diffs.map((diff) => diffToDropDiffOp(diff)),
        metadata: {
          ...metadata,
          followsSeq: branchContent?.headEventSeq ?? -1,
        },
        ...eventIdentity,
      });
      const posted = await dependencies.runtime.diffs.postEnvelope({
        dropId,
        branchId,
        envelope,
      });
      const postedBranchId = branchIdFromPosted(posted, branchId);
      const verifiedContent = branchContentFromResponse(
        await dependencies.runtime.branches.content(dropId, postedBranchId),
        dropId,
      );
      if (verifiedContent?.content !== to) {
        throw new Error(
          "Branch replacement verification failed after the server response. Refresh before retrying.",
        );
      }
      dependencies.print(
        { posted, verified: true },
        `updated branch ${postedBranchId}`,
      );
      return;
    }

    const response = await dependencies.runtime.diffs.poll({
      dropId,
      branchId,
      cursor: subcommand === "latest" ? "__latest__" : (flagString(args, "cursor") ?? "-1"),
      limit: flagString(args, "limit"),
      excludeClient: flagString(args, "exclude-client"),
    });
    dependencies.print(response);
  },
});

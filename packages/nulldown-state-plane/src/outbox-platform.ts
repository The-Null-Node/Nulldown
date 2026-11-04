import type {
  BranchOutboxDeliveryItem,
  BranchClaimedOutbox,
} from "../../../shared/drop/branch-outbox-delivery";
import type {
  BranchContentQuery,
  BranchEventRangeQuery,
  BranchStateContent,
  BranchStatePlacement,
  BranchStateTarget,
  BranchStateVersion,
} from "../../../shared/drop/branch-state";
import type {
  BranchSnapshotQuery,
  BranchSnapshotState,
} from "../../../shared/drop/branch-lifecycle";
import type { DropSnapshotRecord } from "../../../shared/drop/branch";
import type { DropDiffEvent } from "../../../shared/drop/diff";
import { serializeCanonicalJson } from "../../../shared/drop/types";
import { hashNulldownSourceContent } from "../../../shared/drop/resolved/hash";

/** Queue payload is only a pointer to a durable lease; it never carries outbox content. */
export interface OutboxReferenceMessage {
  version: 1;
  target: BranchStateTarget;
  placement: BranchStatePlacement;
  item: BranchOutboxDeliveryItem;
  leaseId: string;
}

/** Exact canonical material returned only after the shard validates the current claim. */
export interface ClaimedOutboxMaterial {
  item: BranchOutboxDeliveryItem;
  claimed: BranchClaimedOutbox;
  identity: { rootDropId: string; branchId: string; generation: number };
  /** Immutable snapshot/event or intent material, never a mutable branch head. */
  artifact: unknown;
  projection: {
    domain: "document" | "runtime_fact" | "nullmem";
    version: number;
    sourceHash: string;
    metadata: Record<string, unknown>;
  };
}

/** Shard-facing lease lifecycle adapter; each method operates on a stable Queue reference. */
export interface OutboxConsumerPort {
  readClaimed(message: OutboxReferenceMessage): Promise<ClaimedOutboxMaterial>;
  acknowledge(message: OutboxReferenceMessage): Promise<boolean>;
  retry(
    message: OutboxReferenceMessage,
    reason: OutboxFailureReason,
  ): Promise<void>;
}

/** Read surface needed to materialize exact historical branch snapshots for archival. */
export interface BranchOutboxMaterializationPort {
  readContent(query: BranchContentQuery): Promise<BranchStateContent>;
  readSnapshot(query: BranchSnapshotQuery): Promise<BranchSnapshotState | null>;
  readEvents(query: BranchEventRangeQuery): Promise<DropDiffEvent[]>;
}

/** Builds deterministic archive material, never substituting a mutable head for an exact receipt version. */
export async function materializeClaimedOutbox(
  claimed: BranchClaimedOutbox,
  item: BranchOutboxDeliveryItem,
  reader: BranchOutboxMaterializationPort,
): Promise<ClaimedOutboxMaterial> {
  const { outbox, target, placement } = claimed;
  const outboxIdentity =
    outbox.kind === "branch.commit.v1"
      ? outbox.receipt
      : outbox.kind === "branch.nullmem.v1"
        ? outbox.result
        : outbox;
  if (
    claimed.status !== "claimed" ||
    outbox.id !== item.outboxId ||
    item.target.rootDropId !== target.rootDropId ||
    item.target.branchId !== target.branchId ||
    item.placement.routingVersion !== placement.routingVersion ||
    item.placement.generation !== placement.generation ||
    serializeCanonicalJson(outboxIdentity.target) !==
      serializeCanonicalJson(target) ||
    serializeCanonicalJson(outboxIdentity.placement) !==
      serializeCanonicalJson(placement)
  )
    throw new Error("claimed_outbox_identity_mismatch");
  let artifact: unknown = outbox;
  let version = 0;
  let sourceHash = "";
  let projectionMetadata: Record<string, unknown> = { kind: outbox.kind };
  const readExactEventRange = async (snapshot: DropSnapshotRecord) => {
    const { patchStartSeq, patchEndSeq, eventIds } = snapshot;
    if (
      patchStartSeq === undefined ||
      patchEndSeq === undefined ||
      !Array.isArray(eventIds)
    )
      throw new Error("invalid_snapshot_range");
    if (patchStartSeq === null || patchEndSeq === null) {
      if (
        patchStartSeq !== null ||
        patchEndSeq !== null ||
        eventIds.length !== 0
      )
        throw new Error("invalid_snapshot_range");
      return [];
    }
    if (
      typeof patchStartSeq !== "number" ||
      typeof patchEndSeq !== "number" ||
      !Number.isSafeInteger(patchStartSeq) ||
      !Number.isSafeInteger(patchEndSeq) ||
      patchStartSeq < 0 ||
      patchEndSeq < patchStartSeq ||
      eventIds.length !== patchEndSeq - patchStartSeq + 1 ||
      eventIds.length > 10_000
    )
      throw new Error("invalid_snapshot_range");
    const start = patchStartSeq;
    const end = patchEndSeq;
    const events: DropDiffEvent[] = [];
    for (let startSeq = start; startSeq <= end; startSeq += 200) {
      const endSeq = Math.min(end, startSeq + 199);
      events.push(
        ...(await reader.readEvents({
          target,
          placement,
          version:
            outbox.kind === "branch.batch-commit.v1"
              ? outbox.version
              : outbox.kind === "branch.commit.v1"
                ? outbox.receipt.version
                : (() => {
                    throw new Error("invalid_outbox_kind");
                  })(),
          startSeq,
          endSeq,
        })),
      );
    }
    if (
      events.length !== eventIds.length ||
      events.some(
        (event, index) =>
          event.seq !== start + index || event.eventId !== eventIds[index],
      )
    )
      throw new Error("snapshot_events_mismatch");
    return events;
  };
  const assertSnapshot = (
    value: BranchSnapshotState,
    exactVersion: BranchStateVersion,
  ): void => {
    if (
      serializeCanonicalJson(value.target) !== serializeCanonicalJson(target) ||
      serializeCanonicalJson(value.placement) !==
        serializeCanonicalJson(placement) ||
      serializeCanonicalJson(value.version) !==
        serializeCanonicalJson(exactVersion) ||
      value.snapshot.rootDropId !== target.rootDropId ||
      value.snapshot.branchId !== target.branchId ||
      value.snapshot.snapshotId !== exactVersion.snapshotId ||
      value.snapshot.sourceContentHash !== exactVersion.sourceContentHash
    )
      throw new Error("snapshot_identity_mismatch");
  };
  const assertContent = async (
    value: BranchStateContent,
    exactVersion: BranchStateVersion,
  ): Promise<void> => {
    if (
      serializeCanonicalJson(value.target) !== serializeCanonicalJson(target) ||
      serializeCanonicalJson(value.placement) !==
        serializeCanonicalJson(placement) ||
      serializeCanonicalJson(value.version) !==
        serializeCanonicalJson(exactVersion) ||
      typeof value.content !== "string"
    )
      throw new Error("content_identity_mismatch");
    if (
      (await hashNulldownSourceContent(value.content)) !==
      exactVersion.sourceContentHash
    )
      throw new Error("content_hash_mismatch");
  };
  if (outbox.kind === "branch.commit.v1") {
    const receipt = outbox.receipt;
    const content = await reader.readContent({
      target,
      placement,
      version: receipt.version,
    });
    const snapshot = await reader.readSnapshot({
      target,
      placement,
      snapshotId: receipt.version.snapshotId,
    });
    if (!snapshot) throw new Error("snapshot_not_found");
    await assertContent(content, receipt.version);
    assertSnapshot(snapshot, receipt.version);
    if (snapshot.snapshot.textLength !== content.content.length)
      throw new Error("snapshot_content_length_mismatch");
    const events = await readExactEventRange(snapshot.snapshot);
    if (
      receipt.version.eventSeq < 0
        ? events.length !== 0
        : events.length === 0 ||
          !events.some(
            (event) =>
              event.eventId === receipt.eventId &&
              event.seq === receipt.version.eventSeq,
          )
    )
      throw new Error("receipt_event_mismatch");
    artifact = {
      outbox,
      content: content.content,
      snapshot: snapshot.snapshot,
      events,
    };
    version = receipt.version.snapshotId;
    sourceHash = receipt.version.sourceContentHash;
    projectionMetadata = {
      kind: outbox.kind,
      snapshotId: version,
      eventSeq: receipt.version.eventSeq,
    };
  } else if (outbox.kind === "branch.batch-commit.v1") {
    const content = await reader.readContent({
      target,
      placement,
      version: outbox.version,
    });
    const snapshot = await reader.readSnapshot({
      target,
      placement,
      snapshotId: outbox.version.snapshotId,
    });
    if (!snapshot) throw new Error("snapshot_not_found");
    await assertContent(content, outbox.version);
    assertSnapshot(snapshot, outbox.version);
    if (snapshot.snapshot.textLength !== content.content.length)
      throw new Error("snapshot_content_length_mismatch");
    const events = await readExactEventRange(snapshot.snapshot);
    if (
      serializeCanonicalJson(events.map((event) => event.eventId)) !==
      serializeCanonicalJson(outbox.eventIds)
    )
      throw new Error("batch_event_identity_mismatch");
    if (
      outbox.receipts.length !== events.length ||
      outbox.receipts.some(
        (receipt, index) =>
          receipt.eventId !== events[index].eventId ||
          receipt.eventSeq !== events[index].seq ||
          receipt.version.snapshotId !== outbox.version.snapshotId ||
          receipt.version.sourceContentHash !==
            outbox.version.sourceContentHash ||
          serializeCanonicalJson(receipt.target) !==
            serializeCanonicalJson(target) ||
          serializeCanonicalJson(receipt.placement) !==
            serializeCanonicalJson(placement),
      )
    )
      throw new Error("batch_receipt_identity_mismatch");
    artifact = {
      outbox,
      content: content.content,
      snapshot: snapshot.snapshot,
      events,
    };
    version = outbox.version.snapshotId;
    sourceHash = outbox.version.sourceContentHash;
    projectionMetadata = {
      kind: outbox.kind,
      snapshotId: version,
      eventSeq: outbox.version.eventSeq,
    };
  } else if (outbox.kind === "branch.runtime-fact.v1") {
    artifact = outbox;
    version = outbox.receipt.event.seq;
    sourceHash = outbox.receipt.payloadHash;
    projectionMetadata = { kind: outbox.kind, seq: version };
  } else {
    artifact = outbox;
    version = outbox.result.memoryRevision;
    sourceHash = outbox.result.head.version.sourceContentHash;
    projectionMetadata = {
      kind: outbox.kind,
      memoryRevision: version,
      operation: outbox.operation,
    };
  }
  if (!Number.isSafeInteger(version) || version < 0 || !sourceHash)
    throw new Error("invalid_projection_identity");
  return {
    item,
    claimed,
    identity: {
      rootDropId: target.rootDropId,
      branchId: target.branchId,
      generation: placement.generation,
    },
    artifact,
    projection: {
      domain:
        outbox.kind === "branch.runtime-fact.v1"
          ? "runtime_fact"
          : outbox.kind === "branch.nullmem.v1"
            ? "nullmem"
            : "document",
      version,
      sourceHash,
      metadata: projectionMetadata,
    },
  };
}

/** Bounded retry reasons persisted by the durable shard delivery adapter. */
export type OutboxFailureReason =
  | "stale_claim"
  | "invalid_material"
  | "seal_failed"
  | "archive_failed"
  | "projection_failed";

/** Expected lease/generation staleness; the expired queue reference can be discarded safely. */
export class StaleOutboxClaimError extends Error {}

/** Rejects malformed or oversized reference messages before hashing or routing them. */
export function isOutboxReferenceMessage(
  value: unknown,
): value is OutboxReferenceMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const exactKeys = (record: object, expected: string[]) => {
    const keys = Object.keys(record).sort();
    return (
      keys.length === expected.length &&
      keys.every((key, index) => key === expected[index])
    );
  };
  const message = value as Partial<OutboxReferenceMessage>;
  const target = message.target;
  const placement = message.placement;
  const item = message.item;
  if (
    !exactKeys(value, ["item", "leaseId", "placement", "target", "version"]) ||
    message.version !== 1 ||
    typeof message.leaseId !== "string" ||
    message.leaseId.length < 1 ||
    message.leaseId.length > 200 ||
    !target ||
    !placement ||
    !item
  )
    return false;
  if (
    typeof target !== "object" ||
    typeof placement !== "object" ||
    typeof item !== "object" ||
    !exactKeys(target, ["branchId", "rootDropId"]) ||
    !exactKeys(placement, ["generation", "routingVersion"]) ||
    !exactKeys(item, ["leaseToken", "outboxId", "placement", "target"])
  )
    return false;
  if (
    !item.target ||
    !item.placement ||
    !exactKeys(item.target, ["branchId", "rootDropId"]) ||
    !exactKeys(item.placement, ["generation", "routingVersion"])
  )
    return false;
  if (
    typeof target.rootDropId !== "string" ||
    target.rootDropId.length < 1 ||
    target.rootDropId.length > 256 ||
    typeof target.branchId !== "string" ||
    target.branchId.length < 1 ||
    target.branchId.length > 256
  )
    return false;
  if (
    placement.routingVersion !== 1 ||
    !Number.isSafeInteger(placement.generation) ||
    placement.generation < 0
  )
    return false;
  if (
    item.target?.rootDropId !== target.rootDropId ||
    item.target?.branchId !== target.branchId ||
    item.placement?.routingVersion !== 1 ||
    item.placement?.generation !== placement.generation ||
    typeof item.outboxId !== "string" ||
    item.outboxId.length < 1 ||
    item.outboxId.length > 2048 ||
    typeof item.leaseToken !== "string" ||
    item.leaseToken.length < 1 ||
    item.leaseToken.length > 2500
  )
    return false;
  return true;
}

/** Versioned AES-GCM envelope persisted to R2; identifiers remain authenticated but outside the ciphertext envelope. */
export interface SealedOutboxArtifact {
  format: "nulldown.outbox.archive.v1";
  keyId: string;
  identityHash: string;
  artifactHash: string;
  iv: string;
  ciphertext: string;
}

/** Converts bytes to canonical unpadded base64 without Node-only APIs. */
function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Loads the configured AES-256-GCM key. The key is never persisted or logged. */
export async function sealOutboxArtifact(
  material: ClaimedOutboxMaterial,
  encodedKey: string,
  keyId: string,
  random: Crypto = crypto,
): Promise<SealedOutboxArtifact> {
  if (
    !material ||
    !material.identity ||
    !material.projection ||
    !/^[A-Za-z0-9._-]{1,120}$/.test(keyId)
  )
    throw new TypeError("invalid_material");
  const identity = material.identity;
  if (
    !identity.rootDropId ||
    !identity.branchId ||
    !Number.isSafeInteger(identity.generation) ||
    identity.generation < 0
  )
    throw new TypeError("invalid_material");
  if (
    typeof encodedKey !== "string" ||
    !/^[A-Za-z0-9+/]{43}=$/.test(encodedKey)
  )
    throw new TypeError("invalid_archive_key");
  const raw = Uint8Array.from(atob(encodedKey), (char) => char.charCodeAt(0));
  if (raw.byteLength !== 32) {
    raw.fill(0);
    throw new TypeError("invalid_archive_key");
  }
  const plaintext = new TextEncoder().encode(
    serializeCanonicalJson(material.artifact),
  );
  const digest = await random.subtle.digest("SHA-256", plaintext);
  const artifactHash = `sha256:${base64(new Uint8Array(digest)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
  const iv = new Uint8Array(12);
  random.getRandomValues(iv);
  const aad = new TextEncoder().encode(
    JSON.stringify([
      "nulldown.outbox.archive.v1",
      keyId,
      identity.rootDropId,
      identity.branchId,
      identity.generation,
      artifactHash,
    ]),
  );
  let ciphertext: ArrayBuffer;
  try {
    const key = await random.subtle.importKey(
      "raw",
      raw,
      { name: "AES-GCM" },
      false,
      ["encrypt"],
    );
    ciphertext = await random.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aad, tagLength: 128 },
      key,
      plaintext,
    );
  } finally {
    raw.fill(0);
  }
  const identityHash = await digestText(
    JSON.stringify([
      identity.rootDropId,
      identity.branchId,
      identity.generation,
    ]),
  );
  return {
    format: "nulldown.outbox.archive.v1",
    keyId,
    identityHash,
    artifactHash,
    iv: base64(iv),
    ciphertext: base64(new Uint8Array(ciphertext)),
  };
}

async function digestText(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return `sha256:${base64(new Uint8Array(digest)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
}

/** Create-only sealed archive persistence boundary; no plaintext crosses this interface. */
export interface ArchivePort {
  /** Conditional create; false means an object already existed and must be verified. */
  putIfAbsent(
    key: string,
    body: string,
    customMetadata: Record<string, string>,
  ): Promise<boolean>;
  readExisting(
    key: string,
  ): Promise<{ metadata: Record<string, string>; body: string } | null>;
}

/** Rebuildable D1 metadata boundary with per-job receipts and domain-scoped cursors. */
export interface ProjectionPort {
  /** Stores an immutable per-job receipt and advances only its own domain cursor monotonically. */
  apply(input: {
    jobRef: string;
    keyId: string;
    domain: "document" | "runtime_fact" | "nullmem";
    rootDropId: string;
    branchId: string;
    generation: number;
    version: number;
    sourceHash: string;
    archiveKey: string;
    artifactHash: string;
    metadata: Record<string, unknown>;
  }): Promise<"applied" | "duplicate">;
}

/** Runtime dependencies for an isolated delivery attempt; telemetry is optional and failure-safe. */
export interface OutboxPlatformDependencies {
  enabled: boolean;
  archiveKey: string;
  archiveKeyId: string;
  archive: ArchivePort;
  projection: ProjectionPort;
  consumer: OutboxConsumerPort;
  emit?: (event: {
    name:
      | "state_plane.outbox.delivery"
      | "state_plane.outbox.consume"
      | "state_plane.outbox.archive"
      | "state_plane.outbox.project"
      | "state_plane.outbox.ack";
    outcome: "success" | "retry" | "stale" | "started";
    reason: string;
    count: number;
    jobRef?: string;
  }) => void;
}

function emitBestEffort(
  dependencies: OutboxPlatformDependencies,
  event: Parameters<NonNullable<OutboxPlatformDependencies["emit"]>>[0],
): void {
  try {
    dependencies.emit?.(event);
  } catch {
    /* telemetry can never affect delivery or primary commit behavior */
  }
}

/** Stable, content-free correlation reference for enqueue, consume, archive, projection and acknowledgement events. */
export async function outboxJobRef(
  item: Pick<BranchOutboxDeliveryItem, "target" | "placement" | "outboxId">,
): Promise<string> {
  if (
    !item?.target ||
    typeof item.target.rootDropId !== "string" ||
    item.target.rootDropId.length < 1 ||
    item.target.rootDropId.length > 256 ||
    typeof item.target.branchId !== "string" ||
    item.target.branchId.length < 1 ||
    item.target.branchId.length > 256 ||
    item.placement?.routingVersion !== 1 ||
    !Number.isSafeInteger(item.placement.generation) ||
    item.placement.generation < 0 ||
    typeof item.outboxId !== "string" ||
    item.outboxId.length < 1 ||
    item.outboxId.length > 2048
  )
    throw new TypeError("invalid_outbox_identity");
  const preimage = JSON.stringify([
    "nulldown.state-plane.outbox-job.v1",
    item.target.rootDropId,
    item.target.branchId,
    item.placement.generation,
    item.outboxId,
  ]);
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(preimage)),
  );
  return `op1_${base64(digest).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
}

const token = (value: string): string =>
  base64(new TextEncoder().encode(value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

/** Derives a content-free immutable R2 path, separated by encryption key version. */
export async function outboxArchiveKey(
  material: ClaimedOutboxMaterial,
  keyId: string,
): Promise<string> {
  return `v1/${await outboxJobRef(material.item)}/${token(keyId)}`;
}

/** Authenticates an existing artifact before treating an R2 retry as idempotent. */
export async function verifySealedOutboxArtifact(
  artifact: SealedOutboxArtifact,
  material: ClaimedOutboxMaterial,
  encodedKey: string,
  keyId: string,
): Promise<boolean> {
  const identity = material.identity;
  const expectedIdentityHash = await digestText(
    JSON.stringify([
      identity.rootDropId,
      identity.branchId,
      identity.generation,
    ]),
  );
  if (
    artifact.format !== "nulldown.outbox.archive.v1" ||
    artifact.keyId !== keyId ||
    artifact.artifactHash.length > 100 ||
    artifact.identityHash !== expectedIdentityHash ||
    !/^[A-Za-z0-9+/]{43}=$/.test(encodedKey)
  )
    return false;
  try {
    const raw = Uint8Array.from(atob(encodedKey), (char) => char.charCodeAt(0));
    if (raw.byteLength !== 32) {
      raw.fill(0);
      return false;
    }
    let key: CryptoKey;
    try {
      key = await crypto.subtle.importKey(
        "raw",
        raw,
        { name: "AES-GCM" },
        false,
        ["decrypt"],
      );
    } finally {
      raw.fill(0);
    }
    const iv = Uint8Array.from(atob(artifact.iv), (char) => char.charCodeAt(0));
    const ciphertext = Uint8Array.from(atob(artifact.ciphertext), (char) =>
      char.charCodeAt(0),
    );
    const aad = new TextEncoder().encode(
      JSON.stringify([
        "nulldown.outbox.archive.v1",
        keyId,
        identity.rootDropId,
        identity.branchId,
        identity.generation,
        artifact.artifactHash,
      ]),
    );
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: aad, tagLength: 128 },
      key,
      ciphertext,
    );
    const hash = new Uint8Array(
      await crypto.subtle.digest("SHA-256", plaintext),
    );
    return (
      `sha256:${base64(hash).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}` ===
        artifact.artifactHash &&
      artifact.artifactHash === (await sealHash(material.artifact))
    );
  } catch {
    return false;
  }
}

async function sealHash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(serializeCanonicalJson(value)),
  );
  return `sha256:${base64(new Uint8Array(digest)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
}

/** Persists one claimed artifact and projection before attempting its fenced acknowledgement. */
export async function deliverClaimedOutbox(
  message: OutboxReferenceMessage,
  dependencies: OutboxPlatformDependencies,
): Promise<"acknowledged" | "stale" | "retry"> {
  if (!dependencies.enabled) return "retry";
  let reason: OutboxFailureReason = "invalid_material";
  let jobRef: string | undefined;
  try {
    jobRef = await outboxJobRef(message.item);
    emitBestEffort(dependencies, {
      name: "state_plane.outbox.consume",
      outcome: "started",
      reason: "claimed_reference",
      count: 1,
      jobRef,
    });
    const material = await dependencies.consumer.readClaimed(message);
    if (
      material.item.outboxId !== message.item.outboxId ||
      material.item.leaseToken !== message.item.leaseToken ||
      material.item.target.rootDropId !== message.target.rootDropId ||
      material.item.target.branchId !== message.target.branchId ||
      material.item.placement.generation !== message.placement.generation
    )
      throw new TypeError("invalid_material");
    reason = "seal_failed";
    const sealed = await sealOutboxArtifact(
      material,
      dependencies.archiveKey,
      dependencies.archiveKeyId,
    );
    const archiveKey = await outboxArchiveKey(
      material,
      dependencies.archiveKeyId,
    );
    reason = "archive_failed";
    const encoded = JSON.stringify(sealed);
    const metadata = {
      format: sealed.format,
      keyId: sealed.keyId,
      artifactHash: sealed.artifactHash,
      generation: String(material.identity.generation),
      version: String(material.projection.version),
      sourceHash: material.projection.sourceHash,
    };
    const created = await dependencies.archive.putIfAbsent(
      archiveKey,
      encoded,
      metadata,
    );
    if (!created) {
      const existing = await dependencies.archive.readExisting(archiveKey);
      if (
        !existing ||
        existing.metadata.format !== metadata.format ||
        existing.metadata.keyId !== metadata.keyId ||
        existing.metadata.artifactHash !== metadata.artifactHash ||
        existing.metadata.generation !== metadata.generation ||
        existing.metadata.version !== metadata.version ||
        existing.metadata.sourceHash !== metadata.sourceHash
      )
        throw new Error("archive_identity_conflict");
      const prior = JSON.parse(existing.body) as SealedOutboxArtifact;
      if (
        prior.format !== sealed.format ||
        prior.keyId !== sealed.keyId ||
        prior.artifactHash !== sealed.artifactHash ||
        prior.identityHash !== sealed.identityHash ||
        typeof prior.iv !== "string" ||
        typeof prior.ciphertext !== "string" ||
        !(await verifySealedOutboxArtifact(
          prior,
          material,
          dependencies.archiveKey,
          dependencies.archiveKeyId,
        ))
      )
        throw new Error("archive_body_conflict");
    }
    emitBestEffort(dependencies, {
      name: "state_plane.outbox.archive",
      outcome: "success",
      reason: created ? "created" : "verified_existing",
      count: 1,
      jobRef,
    });
    reason = "projection_failed";
    const projected = await dependencies.projection.apply({
      jobRef,
      keyId: dependencies.archiveKeyId,
      domain: material.projection.domain,
      ...material.identity,
      version: material.projection.version,
      sourceHash: material.projection.sourceHash,
      archiveKey,
      artifactHash: sealed.artifactHash,
      metadata: material.projection.metadata,
    });
    emitBestEffort(dependencies, {
      name: "state_plane.outbox.project",
      outcome: "success",
      reason: projected,
      count: 1,
      jobRef,
    });
    const acknowledged = await dependencies.consumer.acknowledge(message);
    if (!acknowledged) {
      emitBestEffort(dependencies, {
        name: "state_plane.outbox.ack",
        outcome: "stale",
        reason: "stale_claim",
        count: 1,
        jobRef,
      });
      emitBestEffort(dependencies, {
        name: "state_plane.outbox.delivery",
        outcome: "stale",
        reason: "stale_claim",
        count: 1,
        jobRef,
      });
      return "stale";
    }
    emitBestEffort(dependencies, {
      name: "state_plane.outbox.ack",
      outcome: "success",
      reason: "completed",
      count: 1,
      jobRef,
    });
    emitBestEffort(dependencies, {
      name: "state_plane.outbox.delivery",
      outcome: "success",
      reason: "persisted",
      count: 1,
      jobRef,
    });
    return "acknowledged";
  } catch (error) {
    if (error instanceof StaleOutboxClaimError) {
      if (jobRef)
        emitBestEffort(dependencies, {
          name: "state_plane.outbox.delivery",
          outcome: "stale",
          reason: "stale_claim",
          count: 1,
          jobRef,
        });
      return "stale";
    }
    try {
      await dependencies.consumer.retry(message, reason);
    } catch {
      /* delivery failures cannot escape into primary writes */
    }
    if (jobRef)
      emitBestEffort(dependencies, {
        name: "state_plane.outbox.delivery",
        outcome: "retry",
        reason,
        count: 1,
        jobRef,
      });
    return "retry";
  }
}

/** Processes a bounded queue batch; per-message errors never abort siblings. */
export async function consumeOutboxBatch(
  messages: readonly {
    body: OutboxReferenceMessage;
    ack(): void;
    retry(options?: { delaySeconds?: number }): void;
  }[],
  dependencies: OutboxPlatformDependencies,
): Promise<void> {
  for (const message of messages.slice(0, 100)) {
    if (!isOutboxReferenceMessage(message.body)) {
      message.ack();
      emitBestEffort(dependencies, {
        name: "state_plane.outbox.consume",
        outcome: "stale",
        reason: "invalid_reference",
        count: 1,
      });
      continue;
    }
    const result = await deliverClaimedOutbox(message.body, dependencies);
    if (result === "acknowledged" || result === "stale") message.ack();
    else message.retry({ delaySeconds: 60 });
  }
  for (const message of messages.slice(100))
    message.retry({ delaySeconds: 60 });
}

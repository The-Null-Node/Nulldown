import {
  BRANCH_STATE_ERRORS,
  BranchAppendCommand,
  BranchStateError,
  BranchStateQuery,
  type BranchAppendRecord,
  type BranchAppendOutcome,
  type BranchBatchAppendRecord,
  type BranchBatchAppendResult,
  type BranchContentQuery,
  type BranchEventRangeQuery,
  type BranchHeadQuery,
  type BranchStateContent,
  type BranchStateHead,
} from "../../../shared/drop/branch-state";
import { isDropDiffEvent, type DropDiffEvent } from "../../../shared/drop/diff";
import {
  isDropBranchRecord,
  isDropSnapshotRecord,
} from "../../../shared/drop/branch";
import { captureBranchBatchAppend } from "../../../shared/drop/branch-batch";
import {
  BranchLifecycleQuery,
  sameBranchInitializationIdentity,
  type BranchLifecycleStatePlane,
  type BranchAuthorityRecord,
  type BranchPlacementQuery,
  type BranchReserveRecord,
  type BranchReserveOutcome,
  type BranchInitializeRecord,
  type BranchInitializeOutcome,
  type BranchSnapshotQuery,
  type BranchSnapshotState,
  type BranchSnapshotPageQuery,
  type BranchSnapshotPage,
} from "../../../shared/drop/branch-lifecycle";
import { serializeCanonicalJson } from "../../../shared/drop/types";
import { hashNulldownSourceContent } from "../../../shared/drop/resolved/hash";
import {
  canonicalRuntimeFactJson,
  captureRuntimeFactAppend,
  captureRuntimeFactPage,
  hashRuntimeFactIntent,
  runtimeFactIdentity,
  runtimeFactIntent,
  runtimeFactKey,
  validateRuntimeFactReceipt,
  validateRuntimeFactEvent,
  type BranchRuntimeFactAppendCommand,
  type BranchRuntimeFactAppendResult,
  type BranchRuntimeFactHead,
  type BranchRuntimeFactPage,
  type BranchRuntimeFactPageQuery,
  type BranchRuntimeFactStatePlane,
} from "../../../shared/drop/branch-runtime-facts";

/** Frozen routing-v1 pool size. Changing this requires a new routing version and explicit migration. */
export const BRANCH_STATE_SHARD_COUNT = 16;

/** Derives the frozen routing-v1 shard name from validated branch identity; generation is deliberately excluded. */
export async function branchStateShardName(
  input: BranchHeadQuery,
): Promise<string> {
  const query = BranchStateQuery.head(input);
  if (query.placement.routingVersion !== 1)
    throw new BranchStateError("routing_version_unsupported");
  const preimage = `nulldown.branch-shard.v1\n${JSON.stringify([query.target.rootDropId, query.target.branchId])}`;
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(preimage),
  );
  const index =
    new DataView(hash).getUint32(0, false) % BRANCH_STATE_SHARD_COUNT;
  return `branch-state-v1-${String(index).padStart(2, "0")}`;
}

/** Explicit wire result; custom Error properties are never relied on across workerd RPC. */
export type BranchStateRpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ReturnType<BranchStateError["toRecord"]> };

/** Encodes local typed errors and unknown transport/storage failures without document payloads. */
export async function branchStateRpcResult<T>(
  operation: () => Promise<T>,
): Promise<BranchStateRpcResult<T>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    return {
      ok: false,
      error: (error instanceof BranchStateError
        ? error
        : new BranchStateError("state_unavailable")
      ).toRecord(),
    };
  }
}

/** Decodes an explicit failure record, verifying frozen status/outcome/retry semantics rather than Error properties. */
export function decodeBranchStateRpcResult<T>(
  result: BranchStateRpcResult<T>,
): T {
  if (result && result.ok === true && "value" in result) return result.value;
  if (
    result &&
    result.ok === false &&
    result.error &&
    Object.hasOwn(BRANCH_STATE_ERRORS, result.error.code)
  ) {
    const expected = BRANCH_STATE_ERRORS[result.error.code];
    if (
      result.error.status === expected.status &&
      result.error.outcome === expected.outcome &&
      result.error.retry === expected.retry
    ) {
      throw new BranchStateError(result.error.code);
    }
  }
  throw new BranchStateError("state_unavailable");
}

/** The selected typed RPC methods on a shard stub; no HTTP or lifecycle capabilities. */
export interface BranchStateRpcStub {
  appendRuntimeFact?(
    command: BranchRuntimeFactAppendCommand,
  ): Promise<BranchStateRpcResult<unknown>>;
  readRuntimeFactHead?(
    query: BranchHeadQuery,
  ): Promise<BranchStateRpcResult<BranchRuntimeFactHead>>;
  readRuntimeFacts?(
    query: BranchRuntimeFactPageQuery,
  ): Promise<BranchStateRpcResult<unknown>>;
  readPlacement?(
    query: BranchPlacementQuery,
  ): Promise<BranchStateRpcResult<BranchAuthorityRecord | null>>;
  reserve?(
    command: BranchReserveRecord,
  ): Promise<BranchStateRpcResult<BranchReserveOutcome>>;
  initialize?(
    command: BranchInitializeRecord,
  ): Promise<BranchStateRpcResult<BranchInitializeOutcome>>;
  readSnapshot?(
    query: BranchSnapshotQuery,
  ): Promise<BranchStateRpcResult<BranchSnapshotState | null>>;
  listSnapshots?(
    query: BranchSnapshotPageQuery,
  ): Promise<BranchStateRpcResult<BranchSnapshotPage>>;
  /** Optional only for original four-capability callers; batch requests reject an unextended stub explicitly. */
  appendBatch?(
    command: BranchBatchAppendRecord,
  ): Promise<BranchStateRpcResult<unknown>>;
  append(
    command: BranchAppendRecord,
  ): Promise<BranchStateRpcResult<BranchAppendOutcome>>;
  readHead(
    query: BranchHeadQuery,
  ): Promise<BranchStateRpcResult<BranchStateHead>>;
  readContent(
    query: BranchContentQuery,
  ): Promise<BranchStateRpcResult<BranchStateContent>>;
  readEvents(
    query: BranchEventRangeQuery,
  ): Promise<BranchStateRpcResult<unknown[]>>;
}

/** Per-caller RPC adapter. The supplied resolver is an internal binding boundary, not a public URL. */
export class RpcBranchCommitStatePlane
  implements BranchLifecycleStatePlane, BranchRuntimeFactStatePlane
{
  constructor(
    private readonly resolve: (shardName: string) => BranchStateRpcStub,
  ) {}

  private async call<T>(
    query: BranchHeadQuery,
    invoke: (stub: BranchStateRpcStub) => Promise<BranchStateRpcResult<T>>,
  ): Promise<T> {
    try {
      const name = await branchStateShardName({
        target: query.target,
        placement: query.placement,
      });
      return decodeBranchStateRpcResult(await invoke(this.resolve(name)));
    } catch (error) {
      if (error instanceof BranchStateError) throw error;
      throw new BranchStateError("state_unavailable");
    }
  }

  private runtimeHead(
    value: BranchRuntimeFactHead,
    query: BranchHeadQuery,
  ): BranchRuntimeFactHead {
    try {
      if (
        !value ||
        canonicalRuntimeFactJson(value.target) !==
          canonicalRuntimeFactJson(query.target) ||
        canonicalRuntimeFactJson(value.placement) !==
          canonicalRuntimeFactJson(query.placement) ||
        !Number.isSafeInteger(value.headSeq) ||
        value.headSeq < -1
      )
        throw Error();
      return {
        target: structuredClone(query.target),
        placement: structuredClone(query.placement),
        headSeq: value.headSeq,
      };
    } catch {
      throw new BranchStateError("state_corrupt");
    }
  }

  /** Captures complete JSON intent before routing and verifies the immutable receipt returned by the authority. */
  async appendRuntimeFact(
    input: BranchRuntimeFactAppendCommand,
  ): Promise<BranchRuntimeFactAppendResult> {
    const command = captureRuntimeFactAppend(input);
    const intent = runtimeFactIntent(command.fact);
    const payloadHash = await hashRuntimeFactIntent(intent);
    const value = await this.call(command, (stub) => {
      if (!stub.appendRuntimeFact)
        throw new BranchStateError("capability_unsupported");
      return stub.appendRuntimeFact(command);
    });
    try {
      const result = value as BranchRuntimeFactAppendResult;
      if (
        !result ||
        typeof result.appended !== "boolean" ||
        canonicalRuntimeFactJson(result.target) !==
          canonicalRuntimeFactJson(command.target) ||
        canonicalRuntimeFactJson(result.placement) !==
          canonicalRuntimeFactJson(command.placement)
      )
        throw Error();
      validateRuntimeFactReceipt(result.receipt, command);
      if (
        result.receipt.identity !== runtimeFactIdentity(command.fact) ||
        result.receipt.payloadHash !== payloadHash ||
        runtimeFactIntent(result.receipt.event.fact) !== intent ||
        (await hashRuntimeFactIntent(
          runtimeFactIntent(result.receipt.event.fact),
        )) !== result.receipt.payloadHash
      )
        throw Error();
      return structuredClone(result);
    } catch {
      throw new BranchStateError("state_corrupt");
    }
  }

  /** Reads and validates a fenced runtime-fact horizon. */
  async readRuntimeFactHead(
    input: BranchHeadQuery,
  ): Promise<BranchRuntimeFactHead> {
    const query = BranchStateQuery.head(input);
    const value = await this.call(query, (stub) => {
      if (!stub.readRuntimeFactHead)
        throw new BranchStateError("capability_unsupported");
      return stub.readRuntimeFactHead(query);
    });
    return this.runtimeHead(value, query);
  }

  /** Rejects truncated, mis-scoped, malformed or unpinned RPC pages rather than presenting partial history. */
  async readRuntimeFacts(
    input: BranchRuntimeFactPageQuery,
  ): Promise<BranchRuntimeFactPage> {
    const query = captureRuntimeFactPage(input);
    const value = await this.call(query, (stub) => {
      if (!stub.readRuntimeFacts)
        throw new BranchStateError("capability_unsupported");
      return stub.readRuntimeFacts(query);
    });
    try {
      const page = value as BranchRuntimeFactPage;
      const head = this.runtimeHead(page, query);
      const count = Math.max(
        0,
        Math.min(query.limit, query.headSeq - query.afterSeq),
      );
      if (
        head.headSeq !== query.headSeq ||
        !Array.isArray(page.facts) ||
        page.facts.length !== count ||
        page.nextCursor !== (count ? query.afterSeq + count : null)
      )
        throw Error();
      const identities = new Set<string>();
      const publicIds = new Set<string>();
      const publicKeys = new Set<string>();
      for (const [index, event] of page.facts.entries()) {
        const identity = runtimeFactIdentity(event.fact);
        const key = runtimeFactKey(event.fact);
        validateRuntimeFactEvent(event, query);
        if (
          event.seq !== query.afterSeq + index + 1 ||
          identities.has(identity) ||
          publicIds.has(event.factId) ||
          publicKeys.has(key)
        )
          throw Error();
        identities.add(identity);
        publicIds.add(event.factId);
        publicKeys.add(key);
      }
      return structuredClone({
        ...head,
        facts: page.facts,
        nextCursor: page.nextCursor,
      });
    } catch {
      throw new BranchStateError("state_corrupt");
    }
  }

  private authority(
    value: unknown,
    query: BranchPlacementQuery,
  ): BranchAuthorityRecord {
    try {
      const authority = BranchLifecycleQuery.authority(value);
      if (
        serializeCanonicalJson(authority.target) !==
        serializeCanonicalJson(query.target)
      )
        throw Error();
      return authority;
    } catch {
      throw new BranchStateError("state_corrupt");
    }
  }

  /** Discovers ownership through routing v1 without inventing an expected generation. */
  async readPlacement(
    input: BranchPlacementQuery,
  ): Promise<BranchAuthorityRecord | null> {
    const query = BranchLifecycleQuery.placement(input);
    const value = await this.call(
      { ...query, placement: { routingVersion: 1, generation: 0 } },
      (stub) => {
        if (!stub.readPlacement)
          throw new BranchStateError("capability_unsupported");
        return stub.readPlacement(query);
      },
    );
    return value === null ? null : this.authority(value, query);
  }

  /** Reserves before root materialization; validates the winning identity returned by the shard. */
  async reserve(input: BranchReserveRecord): Promise<BranchReserveOutcome> {
    const command = BranchLifecycleQuery.reserve(input);
    const result = await this.call(command, (stub) => {
      if (!stub.reserve) throw new BranchStateError("capability_unsupported");
      return stub.reserve(command);
    });
    const authority = this.authority(result?.authority, command);
    if (
      (result?.status !== "reserved" && result?.status !== "existing") ||
      serializeCanonicalJson(authority.placement) !==
        serializeCanonicalJson(command.placement) ||
      !sameBranchInitializationIdentity(
        authority.reservation.identity,
        command.identity,
      ) ||
      (result.status === "reserved" &&
        (authority.state !== "pending" ||
          authority.reservation.reservationId !== command.reservationId ||
          authority.reservation.rootRevision !== command.rootRevision))
    )
      throw new BranchStateError("state_corrupt");
    return { status: result.status, authority };
  }

  /** Exact replay returns snapshot zero, independently of the current head. */
  async initialize(
    input: BranchInitializeRecord,
  ): Promise<BranchInitializeOutcome> {
    const command = BranchLifecycleQuery.initialize(input);
    const [payloadHash, sourceContentHash] = await Promise.all([
      hashNulldownSourceContent(
        `nulldown.branch-initialization.v1\n${serializeCanonicalJson(command)}`,
      ),
      hashNulldownSourceContent(command.content),
    ]);
    const result = await this.call(command, (stub) => {
      if (!stub.initialize)
        throw new BranchStateError("capability_unsupported");
      return stub.initialize(command);
    });
    try {
      if (
        !result ||
        (result.status !== "created" && result.status !== "duplicate")
      )
        throw Error();
      const receipt = result.receipt;
      const query = BranchStateQuery.content({
        target: receipt?.target,
        placement: receipt?.placement,
        version: receipt?.initialHead?.version,
      });
      const head = receipt.initialHead;
      if (
        serializeCanonicalJson(query.target) !==
          serializeCanonicalJson(command.target) ||
        serializeCanonicalJson(query.placement) !==
          serializeCanonicalJson(command.placement) ||
        serializeCanonicalJson(head.target) !==
          serializeCanonicalJson(command.target) ||
        serializeCanonicalJson(head.placement) !==
          serializeCanonicalJson(command.placement) ||
        receipt.reservationId !== command.reservationId ||
        receipt.rootRevision !== command.rootRevision ||
        receipt.payloadHash !== payloadHash ||
        query.version.sourceContentHash !== sourceContentHash ||
        !isDropBranchRecord(head.branch) ||
        head.branch.rootDropId !== command.target.rootDropId ||
        head.branch.branchId !== command.target.branchId ||
        head.branch.headSnapshotId !== 0 ||
        head.branch.headEventSeq !== -1 ||
        query.version.snapshotId !== 0 ||
        query.version.eventSeq !== -1
      )
        throw Error();
      return structuredClone(result);
    } catch {
      throw new BranchStateError("state_corrupt");
    }
  }

  private snapshot(
    value: BranchSnapshotState,
    query: BranchSnapshotQuery,
  ): BranchSnapshotState {
    try {
      const identity = BranchStateQuery.content({
        target: value?.target,
        placement: value?.placement,
        version: value?.version,
      });
      const snapshot = value.snapshot;
      if (
        serializeCanonicalJson(identity.target) !==
          serializeCanonicalJson(query.target) ||
        serializeCanonicalJson(identity.placement) !==
          serializeCanonicalJson(query.placement) ||
        identity.version.snapshotId !== query.snapshotId ||
        !isDropSnapshotRecord(snapshot) ||
        snapshot.rootDropId !== query.target.rootDropId ||
        snapshot.branchId !== query.target.branchId ||
        snapshot.snapshotId !== query.snapshotId ||
        snapshot.seq !== query.snapshotId ||
        !snapshot.checkpointed ||
        snapshot.sourceContentHash !== identity.version.sourceContentHash ||
        !Number.isSafeInteger(snapshot.textLength) ||
        snapshot.textLength < 0 ||
        (query.snapshotId === 0
          ? snapshot.parentSnapshotId !== null ||
            snapshot.patchStartSeq !== null ||
            snapshot.patchEndSeq !== null ||
            snapshot.eventIds.length !== 0 ||
            identity.version.eventSeq !== -1
          : snapshot.parentSnapshotId !== query.snapshotId - 1 ||
            !Number.isSafeInteger(snapshot.patchStartSeq) ||
            snapshot.patchStartSeq! < 0 ||
            snapshot.patchEndSeq !== identity.version.eventSeq ||
            snapshot.patchEndSeq! < snapshot.patchStartSeq! ||
            snapshot.eventIds.length !==
              snapshot.patchEndSeq! - snapshot.patchStartSeq! + 1 ||
            new Set(snapshot.eventIds).size !== snapshot.eventIds.length)
      )
        throw Error();
      return structuredClone({ ...identity, snapshot });
    } catch {
      throw new BranchStateError("state_corrupt");
    }
  }

  /** Discovers exact historical metadata through the selected authority only. */
  async readSnapshot(
    input: BranchSnapshotQuery,
  ): Promise<BranchSnapshotState | null> {
    const query = BranchLifecycleQuery.snapshot(input);
    const result = await this.call(query, (stub) => {
      if (!stub.readSnapshot)
        throw new BranchStateError("capability_unsupported");
      return stub.readSnapshot(query);
    });
    return result === null ? null : this.snapshot(result, query);
  }

  /** Validates contiguous ascending pages and their pinned continuation cursor. */
  async listSnapshots(
    input: BranchSnapshotPageQuery,
  ): Promise<BranchSnapshotPage> {
    const query = BranchLifecycleQuery.page(input);
    const result = await this.call(query, (stub) => {
      if (!stub.listSnapshots)
        throw new BranchStateError("capability_unsupported");
      return stub.listSnapshots(query);
    });
    const end = Math.min(
      query.version.snapshotId,
      query.afterSnapshotId + query.limit,
    );
    const cursor = end < query.version.snapshotId ? end : null;
    if (
      !result ||
      !Array.isArray(result.snapshots) ||
      result.snapshots.length !== end - query.afterSnapshotId ||
      result.nextAfterSnapshotId !== cursor
    )
      throw new BranchStateError("state_corrupt");
    const snapshots = result.snapshots.map((value, index) =>
      this.snapshot(value, {
        target: query.target,
        placement: query.placement,
        snapshotId: query.afterSnapshotId + index + 1,
      }),
    );
    if (
      snapshots.some(
        (value) =>
          value.version.snapshotId === query.version.snapshotId &&
          serializeCanonicalJson(value.version) !==
            serializeCanonicalJson(query.version),
      )
    )
      throw new BranchStateError("state_corrupt");
    return { snapshots, nextAfterSnapshotId: cursor };
  }

  /** The durable receiver revalidates payload hashes and all fences. */
  async append(command: BranchAppendRecord): Promise<BranchAppendOutcome> {
    const captured = (await BranchAppendCommand.fromRecord(command)).toRecord();
    return this.call(captured, (stub) => stub.append(captured));
  }
  /** Captures the whole envelope before routing; one RPC preserves the backend transaction boundary. */
  async appendBatch(
    input: BranchBatchAppendRecord,
  ): Promise<BranchBatchAppendResult> {
    const command = captureBranchBatchAppend(input);
    const value = await this.call(command, (stub) => {
      if (!stub.appendBatch)
        throw new BranchStateError("capability_unsupported");
      return stub.appendBatch(command);
    });
    if (!value || typeof value !== "object")
      throw new BranchStateError("state_corrupt");
    const result = value as BranchBatchAppendResult;
    if (
      !isDropBranchRecord(result.branch) ||
      result.branch.rootDropId !== command.target.rootDropId ||
      result.branch.branchId !== command.target.branchId ||
      (result.snapshot !== null &&
        (!isDropSnapshotRecord(result.snapshot) ||
          result.snapshot.rootDropId !== command.target.rootDropId ||
          result.snapshot.branchId !== command.target.branchId ||
          result.snapshot.snapshotId !== result.branch.headSnapshotId)) ||
      typeof result.content !== "string" ||
      !Array.isArray(result.acceptedEvents) ||
      !result.acceptedEvents.every(isDropDiffEvent) ||
      !Number.isSafeInteger(result.deduplicatedCount) ||
      result.deduplicatedCount < 0 ||
      result.deduplicatedCount !==
        command.events.length - result.acceptedEvents.length ||
      !Number.isSafeInteger(result.totalStored) ||
      result.totalStored !== Number(result.branch.headEventSeq) + 1 ||
      !Array.isArray(result.acknowledgements) ||
      result.acknowledgements.length !==
        new Set(command.events.map((event) => event.eventId)).size ||
      result.acknowledgements.some(
        (ack) =>
          !ack ||
          typeof ack.eventId !== "string" ||
          !Number.isSafeInteger(ack.seq) ||
          ack.seq < 0 ||
          !Number.isSafeInteger(ack.snapshotId) ||
          ack.snapshotId < 1 ||
          (ack.status !== "accepted" && ack.status !== "duplicate"),
      )
    ) {
      throw new BranchStateError("state_corrupt");
    }
    const inputIds = [...new Set(command.events.map((event) => event.eventId))];
    const acceptedById = new Map(
      result.acceptedEvents.map((event) => [event.eventId, event]),
    );
    if (
      acceptedById.size !== result.acceptedEvents.length ||
      (result.snapshot === null) !== (result.acceptedEvents.length === 0) ||
      result.acknowledgements.some((ack, index) => {
        const accepted = acceptedById.get(ack.eventId);
        return (
          ack.eventId !== inputIds[index] ||
          ack.seq >= result.totalStored ||
          ack.snapshotId > result.branch.headSnapshotId ||
          (accepted
            ? ack.status !== "accepted" ||
              ack.seq !== accepted.seq ||
              ack.snapshotId !== accepted.snapshotId
            : ack.status !== "duplicate")
        );
      }) ||
      (result.snapshot !== null &&
        (result.snapshot.textLength !== result.content.length ||
          result.snapshot.patchStartSeq !==
            result.totalStored - result.acceptedEvents.length ||
          result.snapshot.patchEndSeq !== result.totalStored - 1 ||
          result.snapshot.eventIds.length !== result.acceptedEvents.length ||
          result.acceptedEvents.some(
            (event, index) =>
              event.dropId !== command.target.rootDropId ||
              !inputIds.includes(event.eventId) ||
              event.seq !== result.snapshot!.patchStartSeq! + index ||
              event.snapshotId !== result.snapshot!.snapshotId ||
              result.snapshot!.eventIds[index] !== event.eventId ||
              (event.metadata?.followsSeq !== undefined &&
                event.metadata.followsSeq !== event.seq - 1),
          )))
    ) {
      throw new BranchStateError("state_corrupt");
    }
    return result;
  }
  /** Returns the authoritative head via the fixed routing layout. */
  async readHead(query: BranchHeadQuery): Promise<BranchStateHead> {
    const captured = BranchStateQuery.head(query);
    return this.call(captured, (stub) => stub.readHead(captured));
  }
  /** Exact content crosses the RPC envelope without a caller-side authority cache. */
  async readContent(query: BranchContentQuery): Promise<BranchStateContent> {
    const captured = BranchStateQuery.content(query);
    return this.call(captured, (stub) => stub.readContent(captured));
  }
  /** Range validation occurs before routing and again at the receiver. */
  async readEvents(query: BranchEventRangeQuery): Promise<DropDiffEvent[]> {
    const captured = BranchStateQuery.range(query);
    const events = await this.call(captured, (stub) =>
      stub.readEvents(captured),
    );
    // Recursive event metadata crosses RPC as by-value data, then regains its validated domain type.
    // This also avoids infinitely instantiating workerd's recursive Stubify<JsonValue> type.
    if (
      !Array.isArray(events) ||
      events.length !== captured.endSeq - captured.startSeq + 1 ||
      !events.every(isDropDiffEvent)
    ) {
      throw new BranchStateError("state_corrupt");
    }
    if (
      events.some(
        (event, index) =>
          event.seq !== captured.startSeq + index ||
          event.dropId !== captured.target.rootDropId ||
          event.snapshotId === undefined ||
          event.snapshotId < 1 ||
          event.snapshotId > captured.version.snapshotId ||
          (event.metadata?.followsSeq !== undefined &&
            event.metadata.followsSeq !== event.seq - 1),
      )
    ) {
      throw new BranchStateError("state_corrupt");
    }
    return events;
  }
}

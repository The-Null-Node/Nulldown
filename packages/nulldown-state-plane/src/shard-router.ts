import {
  BRANCH_STATE_ERRORS,
  BranchAppendCommand,
  BranchStateError,
  BranchStateQuery,
  type BranchAppendRecord,
  type BranchAppendOutcome,
  type BranchBatchStatePlane,
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
export class RpcBranchCommitStatePlane implements BranchBatchStatePlane {
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

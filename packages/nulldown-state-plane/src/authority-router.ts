import {
  BranchStateError,
  BranchStateQuery,
  type BranchStateTarget,
} from "../../../shared/drop/branch-state";
import {
  captureAuthoritySelection,
  type BranchAuthorityClient,
  type BranchAuthoritySelection,
} from "../../../src/server/state-plane/authority-control";
import type { SourceWritePermit } from "../../../src/server/state-plane/source-fence";
import {
  branchStateShardName,
  decodeBranchStateRpcResult,
  type BranchStateRpcResult,
} from "./shard-router";

/** Private application RPC surface of the durable branch authority; migration commands are separate. */
export interface BranchAuthorityRpcStub {
  readAuthority(
    target: BranchStateTarget,
  ): Promise<BranchStateRpcResult<BranchAuthoritySelection>>;
  admitSourceWriter(
    permit: SourceWritePermit,
  ): Promise<BranchStateRpcResult<SourceWritePermit>>;
  completeSourceWriter(
    permit: SourceWritePermit,
  ): Promise<BranchStateRpcResult<{ completed: true }>>;
}

/** Request-lifetime adapter; authority calls use the same frozen target-to-shard mapping as destination commits. */
export class RpcBranchAuthorityClient implements BranchAuthorityClient {
  constructor(
    private readonly resolve: (name: string) => BranchAuthorityRpcStub,
  ) {}

  private async call<T>(
    target: BranchStateTarget,
    work: (stub: BranchAuthorityRpcStub) => Promise<BranchStateRpcResult<T>>,
  ): Promise<T> {
    try {
      const name = await branchStateShardName({
        target,
        placement: { routingVersion: 1, generation: 0 },
      });
      return decodeBranchStateRpcResult(await work(this.resolve(name)));
    } catch (error) {
      if (error instanceof BranchStateError) throw error;
      throw new BranchStateError("state_unavailable");
    }
  }

  /** Reads a fresh durable decision and rejects malformed or mis-scoped responses. */
  async select(target: BranchStateTarget): Promise<BranchAuthoritySelection> {
    const captured = BranchStateQuery.head({
      target,
      placement: { routingVersion: 1, generation: 0 },
    }).target;
    return captureAuthoritySelection(
      await this.call(captured, (stub) => stub.readAuthority(captured)),
      captured,
    );
  }

  /** Acquires a single-use exact-generation permit; retries do not reuse uncertain admissions. */
  async admit(input: SourceWritePermit): Promise<SourceWritePermit> {
    const permit = structuredClone(input);
    const result = await this.call(permit.target, (stub) =>
      stub.admitSourceWriter(permit),
    );
    if (
      result?.target?.rootDropId !== permit.target.rootDropId ||
      result.target.branchId !== permit.target.branchId ||
      result.generation !== permit.generation ||
      result.requestId !== permit.requestId
    )
      throw new BranchStateError("state_corrupt");
    return result;
  }

  /** Confirms settled completion explicitly; missing/malformed acknowledgements remain uncertain. */
  async complete(input: SourceWritePermit): Promise<void> {
    const permit = structuredClone(input);
    const result = await this.call(permit.target, (stub) =>
      stub.completeSourceWriter(permit),
    );
    if (result?.completed !== true) throw new BranchStateError("state_corrupt");
  }
}

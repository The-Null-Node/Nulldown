import type {
  DropRuntimeCompareResult,
  DropRuntimeCompareStatus,
  DropRuntimeProviderScope,
  DropRuntimeVersionRef,
} from "../../../shared/drop/runtime";
import { hashMarkdownSource } from "../../../shared/drop/resolved/hash";
import { serializeCanonicalJson } from "../../../shared/drop/types";
import type { DropProviderPort } from "../void/provider";

/** Reads the current runtime version for a root/branch pair from one provider. */
export type DropRuntimeVersionReader = (input: {
  rootDropId: string;
  branchId: string;
}) => Promise<DropRuntimeVersionRef | null>;

/** Minimal frontend runtime adapter over an existing local or remote provider port. */
export interface DropProviderRuntimeAdapter {
  /** Provider scope served by this adapter. */
  readonly scope: DropRuntimeProviderScope;
  /** Reads the current version known by this provider. */
  getVersion: DropRuntimeVersionReader;
  /** Compares this provider's version with another provider runtime adapter. */
  compare: (
    target: DropProviderRuntimeAdapter,
    ref: { rootDropId: string; branchId: string },
  ) => Promise<DropRuntimeCompareResult>;
}

/** Options for creating a minimal provider runtime adapter. */
export interface CreateDropProviderRuntimeOptions {
  /** Existing void provider port that owns low-level local or remote behavior. */
  provider: Pick<DropProviderPort, "scope">;
  /** Version reader for the provider scope. */
  readVersion: DropRuntimeVersionReader;
}

/** Branch content payload used to derive a runtime version ref. */
export interface DropRuntimeBranchContentSource {
  rootDropId: string;
  branchId: string;
  snapshotId: number;
  content: string;
  metadata?: unknown;
  headEventSeq?: number | null;
  runtimeHeapHash?: string;
}

/** Minimal client shape needed by a remote branch-content version reader. */
export interface DropRuntimeBranchContentClient {
  getBranchContent: (rootId: string, branchId: string) => Promise<unknown>;
}

const compareOptionalHash = (
  field: "contentHash" | "metadataHash" | "runtimeHeapHash",
  local: DropRuntimeVersionRef,
  remote: DropRuntimeVersionRef,
): boolean => {
  const localHash = local[field];
  const remoteHash = remote[field];
  return Boolean(localHash && remoteHash && localHash !== remoteHash);
};

const compareNumbers = (
  local: number | null | undefined,
  remote: number | null | undefined,
): "equal" | "local-ahead" | "remote-ahead" | "unknown" => {
  if (typeof local !== "number" || typeof remote !== "number") {
    return "unknown";
  }
  if (local === remote) return "equal";
  return local > remote ? "local-ahead" : "remote-ahead";
};

const buildCompareReasons = (
  status: DropRuntimeCompareStatus,
  local: DropRuntimeVersionRef | null,
  remote: DropRuntimeVersionRef | null,
): string[] => {
  if (!local || !remote) {
    return ["missing-provider-version"];
  }
  if (status === "metadata-diverged") return ["metadata-hash-mismatch"];
  if (status === "heap-diverged") return ["runtime-heap-hash-mismatch"];
  if (status === "diverged") return ["content-hash-mismatch"];
  if (status === "local-ahead") return ["local-version-newer"];
  if (status === "remote-ahead") return ["remote-version-newer"];
  if (status === "unknown") return ["insufficient-version-watermarks"];
  return [];
};

/** Compares local and remote runtime version refs without mutating either provider. */
export const compareDropRuntimeVersions = (
  local: DropRuntimeVersionRef | null,
  remote: DropRuntimeVersionRef | null,
): DropRuntimeCompareResult => {
  let status: DropRuntimeCompareStatus = "unknown";

  if (local && remote) {
    if (compareOptionalHash("contentHash", local, remote)) {
      status = "diverged";
    } else if (compareOptionalHash("metadataHash", local, remote)) {
      status = "metadata-diverged";
    } else if (compareOptionalHash("runtimeHeapHash", local, remote)) {
      status = "heap-diverged";
    } else {
      const eventSeqStatus = compareNumbers(local.eventSeq, remote.eventSeq);
      const snapshotStatus = compareNumbers(local.snapshotId, remote.snapshotId);
      status = eventSeqStatus !== "unknown" ? eventSeqStatus : snapshotStatus;
    }
  }

  return {
    status,
    local,
    remote,
    reasons: buildCompareReasons(status, local, remote),
  };
};

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isBranchContentSource = (
  value: unknown,
): value is DropRuntimeBranchContentSource => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.rootDropId === "string" &&
    typeof record.branchId === "string" &&
    isNumber(record.snapshotId) &&
    typeof record.content === "string" &&
    (record.headEventSeq === undefined ||
      record.headEventSeq === null ||
      isNumber(record.headEventSeq)) &&
    (record.runtimeHeapHash === undefined ||
      typeof record.runtimeHeapHash === "string")
  );
};

/** Builds a runtime version ref from branch content plus optional metadata. */
export const versionRefFromBranchContent = async (
  source: DropRuntimeBranchContentSource,
): Promise<DropRuntimeVersionRef> => ({
  rootDropId: source.rootDropId,
  branchId: source.branchId,
  snapshotId: source.snapshotId,
  eventSeq: source.headEventSeq ?? null,
  contentHash: await hashMarkdownSource(source.content),
  ...(source.metadata !== undefined
    ? { metadataHash: await hashMarkdownSource(serializeCanonicalJson(source.metadata)) }
    : {}),
  ...(source.runtimeHeapHash ? { runtimeHeapHash: source.runtimeHeapHash } : {}),
});

/** Creates a version reader from an injected branch-content source. */
export const createBranchContentVersionReader = (
  readBranchContent: (input: {
    rootDropId: string;
    branchId: string;
  }) => Promise<DropRuntimeBranchContentSource | null>,
): DropRuntimeVersionReader => async (input) => {
  const source = await readBranchContent(input);
  return source ? versionRefFromBranchContent(source) : null;
};

/** Creates a remote version reader over the existing Nulldown branch content API. */
export const createRemoteBranchContentVersionReader = (
  client: DropRuntimeBranchContentClient,
): DropRuntimeVersionReader =>
  createBranchContentVersionReader(async ({ rootDropId, branchId }) => {
    const data = await client.getBranchContent(rootDropId, branchId);
    return isBranchContentSource(data) ? data : null;
  });

/** Creates a minimal provider runtime adapter from an existing void provider port. */
export const createDropProviderRuntime = ({
  provider,
  readVersion,
}: CreateDropProviderRuntimeOptions): DropProviderRuntimeAdapter => {
  const runtime: DropProviderRuntimeAdapter = {
    scope: provider.scope,
    getVersion: readVersion,
    compare: async (target, ref) =>
      compareDropRuntimeVersions(
        await runtime.getVersion(ref),
        await target.getVersion(ref),
      ),
  };

  return runtime;
};

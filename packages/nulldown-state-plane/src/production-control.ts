import { DROP_ID_LENGTH, isDropIdToken } from "../../../shared/drop/id";
import {
  BranchStateError,
  BranchStateQuery,
  type BranchStateTarget,
} from "../../../shared/drop/branch-state";
import { captureMigrationCertificate } from "../../../src/server/state-plane/authority-control";
import type { SourceFenceCertificate } from "../../../src/server/state-plane/source-fence";
import type { BranchStateObject } from "./branch-state-object";
import {
  branchStateShardName,
  decodeBranchStateRpcResult,
} from "./shard-router";

/** One private management operation; callers provide identities and an index, never source data. */
export type ProductionMigrationCommand =
  | {
      operation: "register" | "source" | "authority";
      target: BranchStateTarget;
    }
  | {
      operation:
        | "freeze"
        | "prepare"
        | "progress"
        | "verify"
        | "transfer"
        | "activate"
        | "abort";
      certificate: SourceFenceCertificate;
    }
  | { operation: "import"; certificate: SourceFenceCertificate; index: number };

/** Private migration-only stub selected from the owning fixed shard. */
export type ProductionMigrationStub = Pick<
  BranchStateObject,
  | "registerLegacyBranch"
  | "readSourceFence"
  | "readAuthority"
  | "freezeLegacyBranch"
  | "prepareBranchMigration"
  | "readBranchMigration"
  | "verifyBranchMigration"
  | "transferBranchMigration"
  | "activateBranchMigration"
  | "abortBranchMigration"
  | "importBranchMigrationChunk"
>;

/** Executes one request-owned management command after deployment scope and identity validation. */
export async function executeProductionMigration(
  enrollment: {
    ENVIRONMENT?: string;
    STATE_PLANE_LOCAL_TEST?: string;
    STATE_PLANE_CANARY_ROOT?: string;
  },
  resolve: (name: string) => ProductionMigrationStub,
  command: ProductionMigrationCommand,
): Promise<unknown> {
  command = structuredClone(command);
  if (!command || typeof command !== "object" || Array.isArray(command))
    throw new BranchStateError("invalid_command");
  const direct = ["register", "source", "authority"].includes(
    command.operation,
  );
  const allowed = direct
    ? ["operation", "target"]
    : command.operation === "import"
      ? ["operation", "certificate", "index"]
      : ["operation", "certificate"];
  if (Object.keys(command).some((key) => !allowed.includes(key)))
    throw new BranchStateError("invalid_command");
  const root = enrollment.STATE_PLANE_CANARY_ROOT;
  if (
    enrollment.ENVIRONMENT !== "production" ||
    enrollment.STATE_PLANE_LOCAL_TEST !== "0" ||
    !root ||
    !isDropIdToken(root) ||
    root.length !== DROP_ID_LENGTH
  )
    throw new BranchStateError("state_unavailable");
  const target = BranchStateQuery.head({
    target:
      direct && "target" in command
        ? command.target
        : "certificate" in command
          ? command.certificate?.target
          : undefined,
    placement: { routingVersion: 1, generation: 0 },
  }).target;
  if (target.rootDropId !== root || target.branchId !== "owner")
    throw new BranchStateError("routing_placement_mismatch");
  const name = await branchStateShardName({
    target,
    placement: { routingVersion: 1, generation: 0 },
  });
  const stub = resolve(name);
  if (command.operation === "register")
    return decodeBranchStateRpcResult(await stub.registerLegacyBranch(target));
  if (command.operation === "source")
    return decodeBranchStateRpcResult(await stub.readSourceFence(target));
  if (command.operation === "authority")
    return decodeBranchStateRpcResult(await stub.readAuthority(target));
  if (!("certificate" in command))
    throw new BranchStateError("invalid_command");
  const certificate = captureMigrationCertificate(command.certificate);
  switch (command.operation) {
    case "freeze":
      return decodeBranchStateRpcResult(
        await stub.freezeLegacyBranch(certificate),
      );
    case "prepare":
      return decodeBranchStateRpcResult(
        await stub.prepareBranchMigration(certificate),
      );
    case "progress":
      return decodeBranchStateRpcResult(
        await stub.readBranchMigration(certificate),
      );
    case "verify":
      return decodeBranchStateRpcResult(
        await stub.verifyBranchMigration(certificate),
      );
    case "transfer":
      return decodeBranchStateRpcResult(
        await stub.transferBranchMigration(certificate),
      );
    case "activate":
      return decodeBranchStateRpcResult(
        await stub.activateBranchMigration(certificate),
      );
    case "abort":
      return decodeBranchStateRpcResult(
        await stub.abortBranchMigration(certificate),
      );
    case "import": {
      if (!Number.isSafeInteger(command.index) || command.index < 0)
        throw new BranchStateError("invalid_command");
      return decodeBranchStateRpcResult(
        await stub.importBranchMigrationChunk(certificate, command.index),
      );
    }
    default:
      throw new BranchStateError("invalid_command");
  }
}

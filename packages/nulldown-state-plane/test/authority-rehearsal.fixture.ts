import {
  BranchStateError,
  type BranchStateTarget,
} from "../../../shared/drop/branch-state";
import { issueAccountSessionToken } from "../../../functions/api/_lib/accounts/session/token";
import { fetchAuthorityStagingApplication } from "../src/staging-api";
import { RpcBranchAuthorityClient } from "../src/authority-router";
import {
  branchStateShardName,
  decodeBranchStateRpcResult,
} from "../src/shard-router";
import type { MigrationRehearsalEnv } from "./migration-rehearsal.fixture";

const owner = "writer-rehearsal-owner";

/** Private synthetic driver using the real BranchStateObject; the enclosing fixture authenticates every call. */
export async function runAuthorityRehearsal(
  input: Record<string, unknown>,
  env: MigrationRehearsalEnv,
  execution: ExecutionContext,
): Promise<Response> {
  const target = input.target as BranchStateTarget;
  if (target.branchId !== "owner")
    return Response.json({ error: "rehearsal_scope_denied" }, { status: 400 });
  const runId = target.rootDropId.slice("MigrationRehearsal-".length);
  const migrationId = `authority-${runId}`;
  const certificate = {
    target,
    sourceGeneration: Number(input.sourceGeneration ?? 0),
    migrationId,
  };
  const name = await branchStateShardName({
    target,
    placement: { routingVersion: 1, generation: 0 },
  });
  const stub = env.BRANCH_STATE.getByName(name);
  const authority = new RpcBranchAuthorityClient((shard) =>
    env.BRANCH_STATE.getByName(shard),
  );
  const held = {
    target,
    generation: certificate.sourceGeneration,
    requestId: `fixture-held:${migrationId}`,
  };
  const action = String(input.action);
  let outcome = "success";
  let reason = "completed";
  try {
    let value: unknown;
    switch (action) {
      case "register": {
        value = decodeBranchStateRpcResult(
          await stub.registerLegacyBranch(target),
        );
        await env.LEGACY_R2.put(
          target.rootDropId,
          JSON.stringify({ content: "", metadata: { ownerAccountId: owner } }),
          {
            httpMetadata: { contentType: "application/json" },
            onlyIf: { etagDoesNotMatch: "*" },
          },
        );
        break;
      }
      case "select":
        value = await authority.select(target);
        break;
      case "source":
        value = decodeBranchStateRpcResult(await stub.readSourceFence(target));
        break;
      case "hold":
        value = await authority.admit(held);
        break;
      // The held identity is fixture-generated and never executes a mutation callback.
      case "completeHeld":
        await authority.complete(held);
        value = { completed: true };
        break;
      case "freeze":
        value = decodeBranchStateRpcResult(
          await stub.freezeLegacyBranch(certificate),
        );
        break;
      case "prepare":
        value = decodeBranchStateRpcResult(
          await stub.prepareBranchMigration(certificate),
        );
        break;
      case "import":
        value = decodeBranchStateRpcResult(
          await stub.importBranchMigrationChunk(
            certificate,
            Number(input.index),
          ),
        );
        break;
      case "progress":
        value = decodeBranchStateRpcResult(
          await stub.readBranchMigration(certificate),
        );
        break;
      case "verify":
        value = decodeBranchStateRpcResult(
          await stub.verifyBranchMigration(certificate),
        );
        break;
      case "transfer":
        value = decodeBranchStateRpcResult(
          await stub.transferBranchMigration(certificate),
        );
        break;
      case "activate":
        value = decodeBranchStateRpcResult(
          await stub.activateBranchMigration(certificate),
        );
        break;
      case "abort":
        value = decodeBranchStateRpcResult(
          await stub.abortBranchMigration(certificate),
        );
        break;
      case "staleAdmission":
        value = await authority.admit({
          ...held,
          requestId: `stale:${migrationId}`,
        });
        break;
      case "application": {
        const path = String(input.path);
        const method = String(input.method ?? "GET");
        if (
          !path.startsWith("/api/") ||
          path.includes("\\") ||
          !["GET", "POST", "DELETE"].includes(method)
        )
          throw new BranchStateError("invalid_command");
        const session = await issueAccountSessionToken(owner, {
          ACCOUNT_AUTH_SECRET: env.MIGRATION_REHEARSAL_TOKEN!,
        });
        const request = new Request(
          `https://authority-rehearsal.invalid${path}`,
          {
            method,
            headers: {
              authorization: `Bearer ${session.token}`,
              "content-type": "application/json",
              "x-operation-id": String(input.requestId),
              "x-nulldown-client-id": "writer-rehearsal",
            },
            ...(method === "GET"
              ? {}
              : { body: JSON.stringify(input.body ?? {}) }),
          },
        );
        let duringAdmission: unknown;
        let selections = 0;
        const destination = new Proxy(stub, {
          get(object, property) {
            if (
              input.fault === "destination-unavailable" &&
              property === "readContent"
            )
              return async () => {
                throw new BranchStateError("state_unavailable");
              };
            const member = Reflect.get(object, property);
            return typeof member === "function"
              ? (...args: unknown[]) => Reflect.apply(member, object, args)
              : member;
          },
        });
        const response = await fetchAuthorityStagingApplication(
          request as Parameters<typeof fetchAuthorityStagingApplication>[0],
          {
            ENVIRONMENT: "staging",
            R2_BUCKET: env.LEGACY_R2 as Parameters<
              typeof fetchAuthorityStagingApplication
            >[1]["R2_BUCKET"],
            DB: env.LEGACY_D1,
            ACCOUNT_AUTH_SECRET: env.MIGRATION_REHEARSAL_TOKEN!,
            PROVIDER_ENCRYPTION_PRIVATE_JWK: "{}",
            PROVIDER_SIGNING_PRIVATE_JWK: "{}",
            LOG_LEVEL: "error",
            STATE_PLANE: destination,
            BRANCH_AUTHORITY: {
              target,
              client: {
                async select(value) {
                  if (
                    ++selections === 2 &&
                    input.fault === "transfer-before-read-validation"
                  )
                    decodeBranchStateRpcResult(
                      await stub.transferBranchMigration(certificate),
                    );
                  return authority.select(value);
                },
                complete: (value) => authority.complete(value),
                async admit(permit) {
                  const accepted = await authority.admit(permit);
                  if (input.fault === "freeze-admitted") {
                    const state = decodeBranchStateRpcResult(
                      await stub.freezeLegacyBranch(certificate),
                    );
                    let concurrentRejection: string | null = null;
                    try {
                      await authority.admit({
                        ...permit,
                        requestId: `concurrent:${permit.requestId}`,
                      });
                    } catch (error) {
                      concurrentRejection =
                        error instanceof BranchStateError
                          ? error.code
                          : "state_unavailable";
                    }
                    duringAdmission = { state, concurrentRejection };
                  }
                  return accepted;
                },
              },
            },
          },
          execution,
        );
        const text = await response.text();
        let body: unknown = text;
        try {
          body = JSON.parse(text);
        } catch {
          /* Preserve plaintext route errors. */
        }
        value = {
          status: response.status,
          body,
          headers: Object.fromEntries(response.headers),
          duringAdmission,
        };
        break;
      }
      default:
        throw new BranchStateError("invalid_command");
    }
    return Response.json({ value, requestId: input.requestId });
  } catch (error) {
    const failure =
      error instanceof BranchStateError
        ? error
        : new BranchStateError("state_unavailable");
    outcome = "failure";
    reason = failure.code;
    return Response.json(
      { error: failure.code, requestId: input.requestId },
      { status: failure.toRecord().status },
    );
  } finally {
    const operation = [
      "register",
      "select",
      "source",
      "hold",
      "completeHeld",
      "freeze",
      "prepare",
      "import",
      "progress",
      "verify",
      "transfer",
      "activate",
      "abort",
      "staleAdmission",
      "application",
    ].includes(action)
      ? action
      : "invalid";
    try {
      console.info(
        JSON.stringify({
          event: "state_plane.authority.fixture",
          version: 1,
          requestId: input.requestId,
          migrationId,
          operation,
          outcome,
          reason,
        }),
      );
    } catch {
      /* Telemetry cannot alter the synthetic operation. */
    }
  }
}

import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import {
  BranchStateError,
  type BranchStateTarget,
} from "../../../shared/drop/branch-state";
import type { BranchSqlPort } from "../../../src/server/state-plane/sqlite-port";
import type {
  SqliteSourceWriteFence,
  SourceWritePermit,
} from "../../../src/server/state-plane/source-fence";
import { issueAccountSessionToken } from "../../../functions/api/_lib/accounts/session/token";
import {
  fetchFencedLegacyStagingApplication,
  fetchStagingApplication,
  type FencedLegacyStagingDependencies,
} from "../src/staging-api";
import { SqliteBranchCommitStatePlane } from "../../../src/server/state-plane/sqlite-commits";
import {
  branchStateRpcResult,
  type BranchStateRpcStub,
} from "../src/shard-router";

type Fault =
  | "none"
  | "admission-lost"
  | "completion-before"
  | "completion-after"
  | "freeze-admitted"
  | "pause-admitted";
const owner = "writer-rehearsal-owner";

/** Isolated fixture control plane; it never selects production authority or accepts arbitrary permits. */
export class WriterApplicationRehearsal {
  private readonly paused = new Map<string, () => void>();
  constructor(
    private readonly sql: BranchSqlPort,
    private readonly fence: SqliteSourceWriteFence,
    private readonly bindings: {
      blobs: R2Bucket;
      db: D1Database;
      secret: string;
      waitUntil(task: Promise<unknown>): void;
    },
  ) {
    sql.execute(
      "CREATE TABLE IF NOT EXISTS writer_rehearsal_control(root TEXT PRIMARY KEY,fault TEXT NOT NULL,permit_json TEXT)",
    );
  }

  /** Registers admission before creating the synthetic root; branch initialization uses the real resolve route. */
  async register(target: BranchStateTarget) {
    this.assertTarget(target);
    const state = this.fence.register(target);
    this.sql.execute(
      "INSERT INTO writer_rehearsal_control(root,fault) VALUES(?,'none') ON CONFLICT(root) DO NOTHING",
      target.rootDropId,
    );
    await this.bindings.blobs.put(
      target.rootDropId,
      JSON.stringify({ content: "", metadata: { ownerAccountId: owner } }),
      {
        httpMetadata: { contentType: "application/json" },
        onlyIf: { etagDoesNotMatch: "*" },
      },
    );
    return state;
  }

  /** Arms exactly one fixture failure; unreconciled proofs cannot be overwritten. */
  fault(target: BranchStateTarget, value: unknown) {
    this.assertTarget(target);
    if (
      ![
        "none",
        "admission-lost",
        "completion-before",
        "completion-after",
        "freeze-admitted",
        "pause-admitted",
      ].includes(String(value))
    )
      throw Error("invalid_fault");
    const row = this.control(target);
    if (row.permit_json) throw Error("reconciliation_required");
    this.sql.execute(
      "UPDATE writer_rehearsal_control SET fault=? WHERE root=?",
      String(value),
      target.rootDropId,
    );
    return { fault: value };
  }

  /** Resumes a live fixture callback; eviction never releases its durable permit. */
  release(target: BranchStateTarget) {
    this.assertTarget(target);
    const resume = this.paused.get(target.rootDropId);
    if (!resume) throw Error("paused_callback_missing");
    this.paused.delete(target.rootDropId);
    resume();
    return { resumed: true };
  }

  /** Replays completion only for fixture-proved no-callback or fully-settled operations. */
  reconcile(target: BranchStateTarget) {
    this.assertTarget(target);
    const row = this.control(target);
    if (!row.permit_json) throw Error("reconciliation_proof_missing");
    // Keep the proof if completion fails; idempotent completion permits crash-safe replay.
    this.fence.complete(JSON.parse(row.permit_json) as SourceWritePermit);
    this.sql.execute(
      "UPDATE writer_rehearsal_control SET permit_json=NULL WHERE root=?",
      target.rootDropId,
    );
    return this.fence.read(target);
  }

  /** Dispatches real Pages adapters with a signed owner session and server-owned captured source authority. */
  async request(
    target: BranchStateTarget,
    input: {
      path?: unknown;
      method?: unknown;
      body?: unknown;
      requestId?: unknown;
      generation?: unknown;
    },
    destination = false,
  ) {
    this.assertTarget(target);
    this.control(target);
    const path = String(input.path);
    if (!path.startsWith("/api/") || path.includes("\\"))
      throw Error("invalid_application_path");
    const method = String(input.method ?? "GET");
    if (!["GET", "POST", "DELETE"].includes(method))
      throw Error("invalid_application_method");
    const generation =
      input.generation === undefined ? 0 : Number(input.generation);
    const env = { ACCOUNT_AUTH_SECRET: this.bindings.secret };
    const session = await issueAccountSessionToken(owner, env);
    const request = new Request(`https://writer-rehearsal.invalid${path}`, {
      method,
      headers: {
        authorization: `Bearer ${session.token}`,
        "content-type": "application/json",
        "x-operation-id": String(input.requestId ?? crypto.randomUUID()),
        "x-nulldown-client-id": "writer-rehearsal",
      },
      ...(method === "GET" ? {} : { body: JSON.stringify(input.body ?? {}) }),
    });
    let fault: Fault = "none";
    const saveProof = (permit: SourceWritePermit) =>
      this.sql.execute(
        "UPDATE writer_rehearsal_control SET permit_json=? WHERE root=?",
        JSON.stringify(permit),
        target.rootDropId,
      );
    const bindings: FencedLegacyStagingDependencies = {
      ENVIRONMENT: "staging",
      R2_BUCKET: this.bindings.blobs,
      DB: this.bindings.db,
      ...env,
      // Plain synthetic roots never require escrow or root signing; the real route guards reject root writes.
      PROVIDER_ENCRYPTION_PRIVATE_JWK: "{}",
      PROVIDER_SIGNING_PRIVATE_JWK: "{}",
      LOG_LEVEL: "error",
      LEGACY_SOURCE_AUTHORITY: {
        target,
        generation,
        admission: {
          admit: async (permit) => {
            const accepted = this.fence.admit(permit);
            fault = this.control(target).fault as Fault;
            this.sql.execute(
              "UPDATE writer_rehearsal_control SET fault='none' WHERE root=?",
              target.rootDropId,
            );
            if (fault === "admission-lost") {
              saveProof(accepted);
              throw Error("fixture_admission_response_lost");
            }
            if (fault === "freeze-admitted")
              this.fence.fence({
                target,
                sourceGeneration: generation,
                migrationId: `migration-rehearsal-${target.rootDropId.slice("MigrationRehearsal-".length)}`,
              });
            if (fault === "pause-admitted")
              await new Promise<void>((resolve) => {
                this.paused.set(target.rootDropId, resolve);
              });
            return accepted;
          },
          complete: (permit) => {
            if (fault === "completion-before") {
              saveProof(permit);
              throw Error("fixture_completion_not_sent");
            }
            this.fence.complete(permit);
            if (fault === "completion-after") {
              saveProof(permit);
              throw Error("fixture_completion_response_lost");
            }
          },
        },
      },
    };
    const typedRequest = request as Parameters<
      typeof fetchFencedLegacyStagingApplication
    >[0];
    const response = destination
      ? await fetchStagingApplication(
          typedRequest,
          { ...bindings, STATE_PLANE: this.destination(target) },
          { waitUntil: this.bindings.waitUntil },
        )
      : await fetchFencedLegacyStagingApplication(typedRequest, bindings, {
          waitUntil: this.bindings.waitUntil,
        });
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* Some real routes return plaintext errors. */
    }
    return {
      status: response.status,
      body,
      headers: Object.fromEntries(response.headers),
    };
  }

  private destination(target: BranchStateTarget): BranchStateRpcStub {
    const plane = new SqliteBranchCommitStatePlane(this.sql);
    const scoped = <T>(
      input: { target: BranchStateTarget },
      work: () => Promise<T>,
    ) =>
      branchStateRpcResult(async () => {
        if (
          input.target.rootDropId !== target.rootDropId ||
          input.target.branchId !== target.branchId
        )
          throw new BranchStateError("routing_placement_mismatch");
        return work();
      });
    return {
      append: (input) => scoped(input, () => plane.append(input)),
      appendBatch: (input) => scoped(input, () => plane.appendBatch(input)),
      readHead: (input) => scoped(input, () => plane.readHead(input)),
      readContent: (input) => scoped(input, () => plane.readContent(input)),
      readEvents: (input) => scoped(input, () => plane.readEvents(input)),
      readPlacement: (input) => scoped(input, () => plane.readPlacement(input)),
      readSnapshot: (input) => scoped(input, () => plane.readSnapshot(input)),
      listSnapshots: (input) => scoped(input, () => plane.listSnapshots(input)),
      queryNullMem: (input) => scoped(input, () => plane.queryNullMem(input)),
      putNullMem: (input) => scoped(input, () => plane.putNullMem(input)),
      deleteNullMem: (input) => scoped(input, () => plane.deleteNullMem(input)),
      appendRuntimeFact: (input) =>
        scoped(input, () => plane.appendRuntimeFact(input)),
      readRuntimeFactHead: (input) =>
        scoped(input, () => plane.readRuntimeFactHead(input)),
      readRuntimeFacts: (input) =>
        scoped(input, () => plane.readRuntimeFacts(input)),
    };
  }

  private control(target: BranchStateTarget) {
    const row = this.sql.rows<{ fault: string; permit_json: string | null }>(
      "SELECT fault,permit_json FROM writer_rehearsal_control WHERE root=?",
      target.rootDropId,
    )[0];
    if (!row) throw Error("writer_application_unregistered");
    return row;
  }

  private assertTarget(target: BranchStateTarget) {
    if (
      target.branchId !== "owner" ||
      !/^MigrationRehearsal-[A-Za-z0-9_-]{1,32}$/.test(target.rootDropId)
    )
      throw Error("rehearsal_scope_denied");
  }
}

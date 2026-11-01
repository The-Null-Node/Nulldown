import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  branchStateShardName,
  branchStateRpcResult,
  decodeBranchStateRpcResult,
  RpcBranchCommitStatePlane,
} from "../src/shard-router";
import type { BranchHeadQuery } from "../../../shared/drop/branch-state";
import {
  assertRecords,
  initialQuery,
  rejectsCode,
} from "../../../src/server/state-plane/testing/commit-contract";

/** Independent fixed vectors for the parent's routing-v1 wire layout. */
export const shardVectors = [
  {
    target: ["OracleRoot001", "owner"],
    hash: "82e094aa92305c30de747acac65930c1a9ae6e798cdcfb3a89b5c990b10588f5",
    name: "branch-state-v1-10",
  },
  {
    target: ["a:b", "c"],
    hash: "96287b243b002d3c0c7f93433d1a8338eb736b0ca9c7ff9c47cfb451922de165",
    name: "branch-state-v1-04",
  },
  {
    target: ["a", "b:c"],
    hash: "b3435c4073828d050bc003c2e4c555df512bd8a2d78080f7ed28b81bc00f6d05",
    name: "branch-state-v1-00",
  },
  {
    target: ["根🧪", "分支é"],
    hash: "4cb5f1f2d69e3fee1f0cb9131621966a690a4d85ef1efe98b2d672127b11f08a",
    name: "branch-state-v1-02",
  },
  {
    target: ["Root00000001", "clone_account:fixture"],
    hash: "a1558aef013cb5cf352aff85d5d460decbf35cb85650f1ccb828c389cc261a91",
    name: "branch-state-v1-15",
  },
] as const;

/** Runs callable Node scenarios; no Vitest runtime or fake DO is introduced. */
export async function runShardRouterContract(): Promise<string[]> {
  for (const vector of shardVectors) {
    const digest = createHash("sha256")
      .update(
        "nulldown.branch-shard.v1\n" + JSON.stringify(vector.target),
        "utf8",
      )
      .digest();
    assert.equal(digest.toString("hex"), vector.hash);
    assert.equal(
      "branch-state-v1-" + String(digest.readUInt32BE(0) % 16).padStart(2, "0"),
      vector.name,
    );
    for (const generation of [0, 7, 999])
      assert.equal(
        await branchStateShardName({
          target: { rootDropId: vector.target[0], branchId: vector.target[1] },
          placement: { routingVersion: 1, generation },
        }),
        vector.name,
      );
  }
  const subtle = crypto.subtle,
    descriptor = Object.getOwnPropertyDescriptor(subtle, "digest");
  let hashes = 0;
  const original = subtle.digest.bind(subtle);
  Object.defineProperty(subtle, "digest", {
    configurable: true,
    value: (...args: Parameters<SubtleCrypto["digest"]>) => {
      hashes++;
      return original(...args);
    },
  });
  try {
    for (const target of [
      { rootDropId: "", branchId: "owner" },
      { rootDropId: "root", branchId: " owner" },
      { rootDropId: "x".repeat(121), branchId: "owner" },
      { rootDropId: "root", branchId: "x".repeat(135) },
    ])
      await rejectsCode(
        () => branchStateShardName({ ...initialQuery(), target }),
        "invalid_command",
      );
    await rejectsCode(
      () =>
        branchStateShardName({
          ...initialQuery(),
          placement: { routingVersion: 2, generation: 7 },
        }),
      "routing_version_unsupported",
    );
    assert.equal(
      hashes,
      0,
      "invalid target/routing is rejected before hashing",
    );
  } finally {
    if (descriptor) Object.defineProperty(subtle, "digest", descriptor);
    else Reflect.deleteProperty(subtle, "digest");
  }
  let resolves = 0;
  const plane = new RpcBranchCommitStatePlane(() => {
    resolves++;
    throw Error("unavailable transport with secret text");
  });
  await rejectsCode(
    () =>
      Promise.resolve().then(() =>
        plane.readHead({
          target: { rootDropId: "", branchId: "owner" },
          placement: { routingVersion: 1, generation: 7 },
        }),
      ),
    "invalid_command",
  );
  assert.equal(resolves, 0);
  await rejectsCode(() => plane.readHead(initialQuery()), "state_unavailable");
  const error = await branchStateRpcResult(async () => {
    throw Error("document plaintext must not escape");
  });
  assertRecords(error, {
    ok: false,
    error: {
      code: "state_unavailable",
      status: 503,
      outcome: "unknown",
      retry: "same-command",
    },
  });
  assert.throws(
    () =>
      decodeBranchStateRpcResult({
        ok: false,
        error: {
          code: "state_unavailable",
          status: 503,
          outcome: "unknown",
          retry: "never",
        },
      } as never),
    /state_unavailable/,
  );
  // The input is captured before async shard hashing, even when caller mutates it.
  const captured: BranchHeadQuery = initialQuery();
  const promise = plane.readHead(captured);
  captured.target.rootDropId = "changed";
  await rejectsCode(() => promise, "state_unavailable");
  return [
    "five independent SHA-256 vectors",
    "generation excluded from shard identity",
    "validation before hashing",
    "unsupported version before lookup",
    "explicit content-free RPC failures",
  ];
}

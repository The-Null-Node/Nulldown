import { describe, expect, it, jest } from "@jest/globals";
import { createBranchRepository } from "../../../functions/api/_lib/branches/storage/repository";
import {
  MemoryD1Database,
  MemoryR2Bucket,
  createBranch,
} from "../../../functions/api/_lib/core/d1/testing/metadata-fixture";
import {
  createNullMemFact,
  createNullMemProcedure,
  deleteNullMemRecord,
  queryNullMem,
} from "../../../functions/api/_lib/nullmem/http";
import { createNullMemService } from "../../../functions/api/_lib/nullmem/service";
import type { BlobObjectStore, SqlMetadataStore } from "../ports";

const setup = async () => {
  const blobs = new MemoryR2Bucket() as unknown as BlobObjectStore;
  const sql = new MemoryD1Database() as unknown as SqlMetadataStore;
  const branch = createBranch({ headSnapshotId: 3 });
  await blobs.put(branch.rootDropId, JSON.stringify({ content: "# Memory" }));
  await createBranchRepository({ blobs, sql }).writeBranch(branch);
  const memory = createNullMemService({ blobs, sql });
  const env = { R2_BUCKET: blobs, DB: sql, ALLOW_INSECURE_ACCOUNT_HEADER: "1" };
  const params = { rootId: branch.rootDropId, branchId: branch.branchId };
  const request = (
    method: string,
    body?: unknown,
    account = branch.writerAccountId ?? "acct_1",
    query = "",
  ) =>
    new Request(`https://nulldown.test/api/memory${query}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "x-nulldown-account-id": account,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { memory, env, params, request, branch };
};

describe("State Plane memory HTTP injection", () => {
  it("preserves fact/procedure/query/delete behavior and query-time freshness through the injected service", async () => {
    const { memory, env, params, request, branch } = await setup();
    const fact = jest.spyOn(memory, "createFact");
    const procedure = jest.spyOn(memory, "createProcedure");
    const query = jest.spyOn(memory, "query");
    const remove = jest.spyOn(memory, "delete");
    const services = { memory };
    const target = { rootDropId: branch.rootDropId, branchId: branch.branchId };
    const factInput = {
      recordId: "state-plane-fact",
      text: "Remember this behavior",
      labels: ["state-plane"],
      sourceRefs: [{ kind: "snapshot", ...target, snapshotId: 0 }],
    };
    const factResponse = await createNullMemFact(
      env,
      params,
      request("POST", factInput),
      services,
    );
    expect(factResponse.status).toBe(201);
    expect(fact).toHaveBeenCalledWith({ ...target, fact: factInput });
    const factResult = await fact.mock.results[0].value;
    expect(await factResponse.json()).toEqual(factResult);

    const procedureInput = {
      recordId: "state-plane-procedure",
      goal: "Remember",
      summary: "Reusable behavior",
      labels: ["state-plane"],
    };
    const procedureResponse = await createNullMemProcedure(
      env,
      params,
      request("POST", procedureInput),
      services,
    );
    expect(procedureResponse.status).toBe(201);
    expect(procedure).toHaveBeenCalledWith({
      ...target,
      procedure: procedureInput,
    });
    expect(await procedureResponse.json()).toEqual(
      await procedure.mock.results[0].value,
    );

    const queryResponse = await queryNullMem(
      env,
      params,
      request(
        "GET",
        undefined,
        undefined,
        "?labels=state-plane&includeFreshness=true",
      ),
      services,
    );
    expect(queryResponse.status).toBe(200);
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        ...target,
        labels: ["state-plane"],
        includeFreshness: true,
      }),
    );
    const queried = await query.mock.results[0].value;
    const queryBody = (await queryResponse.json()) as {
      records: unknown[];
      freshness: unknown[];
    };
    expect(queryBody.records).toEqual(queried.records);
    expect(queryBody.freshness).toEqual(queried.freshness);
    expect(queried.records.map((record) => record.recordId).sort()).toEqual([
      "state-plane-fact",
      "state-plane-procedure",
    ]);
    expect(queried.freshness).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recordId: "state-plane-fact",
          currentSnapshotId: 3,
        }),
      ]),
    );

    const deletion = await deleteNullMemRecord(
      env,
      { ...params, recordId: "state-plane-fact" },
      request("DELETE"),
      services,
    );
    expect(deletion.status).toBe(200);
    expect(remove).toHaveBeenCalledWith({
      ...target,
      recordId: "state-plane-fact",
    });
    expect(await deletion.json()).toEqual(await remove.mock.results[0].value);
    const remaining = await memory.query({
      ...target,
      labels: ["state-plane"],
    });
    expect(remaining.records.map((record) => record.recordId)).toEqual([
      "state-plane-procedure",
    ]);
  });

  it("keeps authorization and validation ahead of injected mutations, including the SQL prerequisite", async () => {
    const { memory, env, params, request } = await setup();
    const fact = jest.spyOn(memory, "createFact");
    const procedure = jest.spyOn(memory, "createProcedure");
    const remove = jest.spyOn(memory, "delete");
    const services = { memory };
    expect(
      (
        await createNullMemFact(
          env,
          params,
          request("POST", {}, "outsider"),
          services,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await createNullMemProcedure(
          env,
          params,
          request("POST", {}, "outsider"),
          services,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await deleteNullMemRecord(
          env,
          params,
          request("DELETE", undefined, "outsider"),
          services,
        )
      ).status,
    ).toBe(403);
    expect(
      (await createNullMemFact(env, params, request("POST", {}), services))
        .status,
    ).toBe(400);
    expect(
      (await createNullMemProcedure(env, params, request("POST", {}), services))
        .status,
    ).toBe(400);
    expect(
      (await deleteNullMemRecord(env, params, request("DELETE"), services))
        .status,
    ).toBe(400);
    expect(
      (
        await createNullMemFact(
          { ...env, DB: undefined },
          params,
          request("POST", { text: "unused" }),
          services,
        )
      ).status,
    ).toBe(500);
    expect(fact).not.toHaveBeenCalled();
    expect(procedure).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
});

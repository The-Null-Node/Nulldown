import { createBranchApiClient } from "./branchApi";
import type {
  NullplugUiResponseFact,
  NullplugUiStatePatchFact,
} from "../nullplug/ui";

describe("branch api client", () => {
  it("lists branches with the configured authentication headers", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = createBranchApiClient({
      baseUrl: "https://nulldown.test/",
      accountId: "acct-1",
      clientId: "client-1",
      authTokenProvider: async () => "session-token",
      fetchImpl: (async (input, init) => {
        calls.push({ url: String(input), init });
        return Response.json({ rootDropId: "root-1", branches: [] });
      }) as typeof fetch,
    });

    await expect(client.listBranches("root-1")).resolves.toEqual({
      rootDropId: "root-1",
      branches: [],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://nulldown.test/api/branches/root-1");
    expect(calls[0]?.init?.method).toBe("GET");
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("x-nulldown-account-id")).toBe("acct-1");
    expect(headers.get("x-nulldown-client-id")).toBe("client-1");
    expect(headers.get("authorization")).toBe("Bearer session-token");
  });

  it("submits nullplug responses with account and bearer authentication", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fact: NullplugUiResponseFact = {
      version: 1,
      kind: "ui.response",
      id: "response-1",
      primitiveId: "release-42",
      createdAt: 1,
      source: { rootDropId: "root-1", branchId: "branch-1" },
      data: { approved: true },
    };
    const client = createBranchApiClient({
      baseUrl: "https://nulldown.test/",
      accountId: "acct-1",
      clientId: "client-1",
      authTokenProvider: async () => "session-token",
      fetchImpl: (async (input, init) => {
        calls.push({ url: String(input), init });
        return Response.json({
          stored: true,
          indexed: true,
          key: "fact-key",
          fact,
        });
      }) as typeof fetch,
    });

    await expect(client.submitNullplugResponse(fact)).resolves.toEqual(
      expect.objectContaining({ stored: true, indexed: true, fact }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://nulldown.test/api/nullplug/submit");
    expect(calls[0]?.init?.method).toBe("POST");
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("x-nulldown-account-id")).toBe("acct-1");
    expect(headers.get("x-nulldown-client-id")).toBe("client-1");
    expect(headers.get("authorization")).toBe("Bearer session-token");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(fact);
  });

  it("submits nullplug state with account and bearer authentication", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fact: NullplugUiStatePatchFact = {
      version: 1,
      kind: "ui.state.patch",
      id: "patch-1",
      callId: "call-1",
      createdAt: 1,
      source: {
        rootDropId: "root-1",
        branchId: "branch-1",
        sourceContentHash: "sha256:source",
      },
      patch: [{ op: "set", path: ["approved"], value: true }],
    };
    const client = createBranchApiClient({
      baseUrl: "https://nulldown.test/",
      accountId: "acct-1",
      clientId: "client-1",
      authTokenProvider: async () => "session-token",
      fetchImpl: (async (input, init) => {
        calls.push({ url: String(input), init });
        return Response.json({ stored: true, indexed: true, key: "state-key", fact });
      }) as typeof fetch,
    });

    await expect(client.submitNullplugState(fact)).resolves.toEqual(
      expect.objectContaining({ stored: true, indexed: true, fact }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://nulldown.test/api/nullplug/state");
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("x-nulldown-account-id")).toBe("acct-1");
    expect(headers.get("authorization")).toBe("Bearer session-token");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(fact);
  });

  it("forwards the fenced promotion identity as JSON", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = createBranchApiClient({
      baseUrl: "https://nulldown.test/",
      accountId: "acct-1",
      fetchImpl: (async (input, init) => {
        calls.push({ url: String(input), init });
        return Response.json({
          dropId: "promoted-1",
          url: "https://nulldown.test/d/promot",
          rootDropId: "root-1",
          branchId: "branch-1",
          snapshotId: 4,
        });
      }) as typeof fetch,
    });

    await expect(
      client.promoteBranch("root-1", "branch-1", {
        expectedSnapshotId: 4,
        idempotencyKey: "promotion-1",
      }),
    ).resolves.toEqual(expect.objectContaining({ dropId: "promoted-1" }));
    expect(calls[0]?.url).toBe(
      "https://nulldown.test/api/branches/root-1/branch-1/promote",
    );
    expect(calls[0]?.init?.method).toBe("POST");
    expect(new Headers(calls[0]?.init?.headers).get("content-type")).toBe(
      "application/json",
    );
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      expectedSnapshotId: 4,
      idempotencyKey: "promotion-1",
    });
  });
});

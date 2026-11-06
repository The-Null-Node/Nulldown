import { jest } from "@jest/globals";
import { onRequestDelete } from "./[id]";

describe("drop deletion capability guard", () => {
  it("rejects deletion under a legacy source fence before canonical access", async () => {
    const head = jest.fn();
    const request = new Request("https://nulldown.test/api/delete/root", {
      method: "DELETE",
      headers: { "x-nulldown-account-id": "acct-owner" },
    });
    const response = await onRequestDelete({
      env: {
        R2_BUCKET: { head } as never,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
        legacySourceWriter: { run: async <T>() => undefined as T },
      },
      params: { id: "root" },
      request,
    } as never);

    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({
      code: "capability_unsupported",
    });
    expect(head).not.toHaveBeenCalled();
  });
});

import { createHmac } from "node:crypto";
import {
  DIFF_CLIENT_ID_HEADER,
  DIFF_SECRET_KID_HEADER,
  DIFF_SIGNATURE_HEADER,
  DIFF_SIGNATURE_PREFIX,
  DIFF_TIMESTAMP_HEADER,
  buildDiffSigningPayload,
} from "../../shared/drop/diffAuth";
import { createNulldownClient } from "./nulldownClient";

const base64UrlEncode = (value: string): string =>
  Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

describe("NulldownClient", () => {
  it("signs diff_apply requests with exported diff auth tokens", async () => {
    const token = `ndauth.v1.${base64UrlEncode(
      JSON.stringify({
        version: 1,
        kind: "nulldown.diff-auth.v1",
        createdAt: 1,
        keys: null,
        credentials: {
          "drop-canonical": {
            version: 1,
            dropId: "drop-canonical",
            branchId: "branch-1",
            baseUrl: "https://nulldown.test",
            clientId: "client-1",
            kid: "kid-1",
            secret: "secret-1",
            createdAt: 1,
            expiresAt: null,
          },
        },
      }),
    )}`;
    const captured: { url?: string; init?: RequestInit } = {};
    const client = createNulldownClient({
      baseUrl: "https://nulldown.test",
      diffAuthToken: token,
      fetch: async (url, init) => {
        captured.url = String(url);
        captured.init = init;
        return Response.json({ accepted: 1 });
      },
    });

    await client.applyDiff({
      dropId: "route-drop",
      branchId: "branch-1",
      eventDropId: "drop-canonical",
      ops: [{ type: "insert", start: 0, end: 0, text: "hello" }],
    });

    const headers = new Headers(captured.init?.headers);
    const timestamp = headers.get(DIFF_TIMESTAMP_HEADER) ?? "";
    const body = String(captured.init?.body ?? "");
    const expectedSignature = `${DIFF_SIGNATURE_PREFIX}${createHmac(
      "sha256",
      "secret-1",
    )
      .update(buildDiffSigningPayload("POST", "/api/diff/route-drop", timestamp, body))
      .digest("hex")}`;

    expect(captured.url).toBe(
      "https://nulldown.test/api/diff/route-drop?branchId=branch-1",
    );
    expect(headers.get(DIFF_CLIENT_ID_HEADER)).toBe("client-1");
    expect(headers.get(DIFF_SECRET_KID_HEADER)).toBe("kid-1");
    expect(headers.get(DIFF_SIGNATURE_HEADER)).toBe(expectedSignature);
    expect(JSON.parse(body)).toEqual(
      expect.objectContaining({
        version: 1,
        events: [
          expect.objectContaining({
            dropId: "drop-canonical",
            sourceClientId: "nulldown-mcp",
          }),
        ],
      }),
    );
  });
});

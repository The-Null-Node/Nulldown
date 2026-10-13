import { jest } from "@jest/globals";
import {
  createNulldownHttpResponseError,
  requestNulldownHttp,
} from "./http-transport";

describe("portable HTTP transport", () => {
  it("returns raw text and parsed JSON from one response read", async () => {
    const response = await requestNulldownHttp(
      async () => Response.json({ ok: true }),
      "https://nulldown.test/api/test",
    );

    expect(response).toMatchObject({
      ok: true,
      status: 200,
      text: '{"ok":true}',
      data: { ok: true },
    });
  });

  it("rejects malformed successful JSON with a stable error", async () => {
    await expect(
      requestNulldownHttp(
        async () =>
          new Response("{not-json", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        "https://nulldown.test/api/test",
      ),
    ).rejects.toMatchObject({
      message: "Response body was not valid JSON.",
      code: "invalid_json_response",
      status: 200,
    });
  });

  it("preserves structured API errors", async () => {
    const response = await requestNulldownHttp(
      async () =>
        Response.json(
          { error: "Conflict.", code: "branch_conflict" },
          { status: 409 },
        ),
      "https://nulldown.test/api/test",
    );

    expect(createNulldownHttpResponseError(response)).toMatchObject({
      message: "Conflict.",
      code: "branch_conflict",
      status: 409,
    });
  });

  it("distinguishes timeouts from caller cancellation", async () => {
    const waitForAbort = async (
      _input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          {
            once: true,
          },
        );
      });

    await expect(
      requestNulldownHttp(waitForAbort, "https://nulldown.test/api/test", {
        timeoutMs: 1,
      }),
    ).rejects.toMatchObject({
      message: "Request timed out.",
      code: "request_timeout",
    });

    const controller = new AbortController();
    const pending = requestNulldownHttp(
      waitForAbort,
      "https://nulldown.test/api/test",
      { init: { signal: controller.signal } },
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      message: "Request was aborted.",
      code: "request_aborted",
    });
  });

  it("does not fetch when the caller signal is already aborted", async () => {
    const fetchImpl = jest.fn(async () => Response.json({ ok: true }));
    const controller = new AbortController();
    controller.abort();

    await expect(
      requestNulldownHttp(fetchImpl, "https://nulldown.test/api/test", {
        init: { signal: controller.signal },
      }),
    ).rejects.toMatchObject({ code: "request_aborted" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("classifies network failures without exposing fetch-specific behavior", async () => {
    await expect(
      requestNulldownHttp(async () => {
        throw new Error("socket details");
      }, "https://nulldown.test/api/test"),
    ).rejects.toMatchObject({
      message: "Request failed.",
      code: "request_failed",
    });
  });

  it.each([0, 2_147_483_648, 1.5])(
    "rejects invalid request timeout %s before fetch",
    async (timeoutMs) => {
      const fetchImpl = jest.fn(async () => Response.json({ ok: true }));

      await expect(
        requestNulldownHttp(fetchImpl, "https://nulldown.test/api/test", {
          timeoutMs,
        }),
      ).rejects.toMatchObject({ code: "invalid_request_timeout" });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it("removes the caller abort listener after completion", async () => {
    const controller = new AbortController();
    const removeEventListener = jest.spyOn(
      controller.signal,
      "removeEventListener",
    );

    await requestNulldownHttp(
      async () => Response.json({ ok: true }),
      "https://nulldown.test/api/test",
      { init: { signal: controller.signal } },
    );

    expect(removeEventListener).toHaveBeenCalledWith(
      "abort",
      expect.any(Function),
    );
  });
});

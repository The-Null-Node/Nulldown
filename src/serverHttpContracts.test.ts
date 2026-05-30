import { createNulldownServer } from "./server/http";

describe("createNulldownServer", () => {
  it("dispatches Web requests by method and path params", async () => {
    const server = createNulldownServer({
      routes: [
        {
          method: "GET",
          path: "/api/get/:id",
          handler: ({ params, url }) =>
            Response.json({ id: params.id, q: url.searchParams.get("q") }),
        },
      ],
    });

    const response = await server.fetch("https://example.test/api/get/root%3A1?q=plan");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ id: "root:1", q: "plan" });
  });

  it("returns 405 with Allow when a path matches another method", async () => {
    const server = createNulldownServer({
      routes: [
        {
          method: "POST",
          path: "/api/store",
          handler: () => new Response("stored"),
        },
      ],
    });

    const response = await server.fetch("https://example.test/api/store");

    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("OPTIONS, POST");
  });

  it("returns the default JSON 404 when no route matches", async () => {
    const server = createNulldownServer({ routes: [] });

    const response = await server.fetch("https://example.test/missing");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      code: "not_found",
      error: "Route not found.",
    });
  });

  it("allows adapters to map handler errors", async () => {
    const server = createNulldownServer({
      routes: [
        {
          method: "GET",
          path: "/api/fail",
          handler: () => {
            throw new Error("boom");
          },
        },
      ],
      onError: (error) =>
        Response.json(
          { message: error instanceof Error ? error.message : "unknown" },
          { status: 599 },
        ),
    });

    const response = await server.fetch("https://example.test/api/fail");

    expect(response.status).toBe(599);
    await expect(response.json()).resolves.toEqual({ message: "boom" });
  });
});

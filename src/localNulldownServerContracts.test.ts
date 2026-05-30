import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalNulldownServer } from "./server/local";

describe("createLocalNulldownServer", () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "nulldown-local-"));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("stores and retrieves a plaintext drop through Web routes", async () => {
    const server = createLocalNulldownServer({
      dataDir,
      publicBaseUrl: "http://127.0.0.1:8788",
      logLevel: "error",
    });

    const stored = await server.fetch("http://127.0.0.1:8788/api/store", {
      method: "POST",
      body: "hello void",
      headers: { "Content-Type": "text/plain" },
    });
    const storedBody = await stored.json() as { id: string };

    expect(stored.status).toBe(200);
    expect(storedBody.id).toEqual(expect.any(String));

    const fetched = await server.fetch(`http://127.0.0.1:8788/api/get/${storedBody.id}`);

    expect(fetched.status).toBe(200);
    await expect(fetched.text()).resolves.toBe("hello void");
  });

  it("appends diff events and materializes branch content locally", async () => {
    const server = createLocalNulldownServer({
      dataDir,
      publicBaseUrl: "http://127.0.0.1:8788",
      logLevel: "error",
    });
    const stored = await server.fetch("http://127.0.0.1:8788/api/store", {
      method: "POST",
      body: "base",
      headers: { "Content-Type": "text/plain" },
    });
    const { id } = await stored.json() as { id: string };

    const appended = await server.fetch(`http://127.0.0.1:8788/api/diff/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        version: 1,
        events: [
          {
            eventId: "evt-local-1",
            seq: 0,
            dropId: id,
            sourceClientId: "local-test",
            createdAt: Date.now(),
            ops: [{ type: "insert", start: 0, end: 0, text: "local " }],
          },
        ],
      }),
    });
    const appendBody = await appended.json() as { branchId: string; snapshotId: number };

    expect(appended.status).toBe(200);
    expect(appendBody).toEqual(expect.objectContaining({ branchId: "clone_anonymous", snapshotId: 1 }));

    const content = await server.fetch(
      `http://127.0.0.1:8788/api/branches/${id}/${appendBody.branchId}/content`,
    );

    expect(content.status).toBe(200);
    await expect(content.json()).resolves.toEqual(expect.objectContaining({ content: "local base" }));
  });
});

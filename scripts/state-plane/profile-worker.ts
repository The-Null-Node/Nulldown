import { writeFileSync } from "node:fs";

/** Captures one local workerd CPU profile; the inspector session lasts only for this diagnostic run. */
export const profileWorker = async (
  inspector: URL,
  worker: string,
  path: string,
  run: () => Promise<void>,
): Promise<void> => {
  const discovery = new URL("/json/list", inspector);
  discovery.protocol = "http:";
  const response = await fetch(discovery, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw Error("Inspector discovery failed");
  const targets = (await response.json()) as {
    id: string;
    title: string;
    webSocketDebuggerUrl: string;
  }[];
  const target = targets.find((entry) => entry.id === `core:user:${worker}`);
  if (!target)
    throw Error(
      `Inspector target missing: ${worker}; available: ${targets.map((entry) => entry.id).join(", ")}`,
    );
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map<
    number,
    {
      resolve: (value: Record<string, unknown>) => void;
      reject: (error: Error) => void;
    }
  >();
  let nextId = 0;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as {
      id?: number;
      result?: Record<string, unknown>;
      error?: { message: string };
    };
    if (message.id === undefined) return;
    const call = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) call?.reject(Error(message.error.message));
    else call?.resolve(message.result ?? {});
  });
  socket.addEventListener("close", () => {
    for (const call of pending.values()) call.reject(Error("Inspector closed"));
    pending.clear();
  });
  const command = (
    method: string,
    params = {},
  ): Promise<Record<string, unknown>> => {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Error(`Inspector timeout: ${method}`));
      }, 10_000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error("Inspector connection timeout")),
        10_000,
      );
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(Error("Inspector connection failed"));
        },
        { once: true },
      );
    });
    await command("Profiler.enable");
    await command("Profiler.setSamplingInterval", { interval: 100 });
    await command("Profiler.start");
    try {
      await run();
    } finally {
      const result = await command("Profiler.stop");
      writeFileSync(path, JSON.stringify(result.profile));
    }
  } finally {
    socket.close();
  }
};

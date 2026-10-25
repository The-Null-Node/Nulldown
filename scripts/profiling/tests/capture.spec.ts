import { test, expect } from "bun:test";
import { captureChild } from "../capture";
test("runner drains stderr larger than pipe capacity while stdout remains open", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      'process.stderr.write("x".repeat(2*1024*1024),()=>{process.stdout.write("done");});',
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  try {
    const result = await captureChild(child);
    expect(result.exit).toBe(0);
    expect(result.stdout).toBe("done");
    expect(result.stderr.length).toBe(2 * 1024 * 1024);
  } finally {
    child.kill();
  }
}, 5000);

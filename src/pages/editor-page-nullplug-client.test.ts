import { readFileSync } from "node:fs";

const editorPageSource = readFileSync(
  new URL("./EditorPage.tsx", import.meta.url),
  "utf8",
);

describe("EditorPage nullplug client boundary", () => {
  it("creates one editor-session client for nullplug invocation", () => {
    expect(editorPageSource).toContain(
      "nullplugClientRef.current = createBrowserNullplugClient();",
    );
    expect(editorPageSource).toContain("nullplugRuntime: nullplugClient");
    expect(editorPageSource).not.toContain("getDefaultRemoteNullplugRuntime");
  });

  it("retains active branch validation before delegating fact submission", () => {
    expect(editorPageSource).toContain(
      "A remote branch session is required for approval responses.",
    );
    expect(editorPageSource).toContain(
      "The approval response does not match the active branch.",
    );
    expect(editorPageSource).toContain(
      "A remote branch session is required for UI state.",
    );
    expect(editorPageSource).toContain(
      "The UI state does not match the active branch.",
    );
    expect(editorPageSource).toContain(
      "await nullplugClient.submitResponse(",
    );
    expect(editorPageSource).toContain("await nullplugClient.submitState(");
    expect(editorPageSource.match(/createBranchApiClient\(/g)).toHaveLength(3);
  });
});

import {
  buildSeedDropContent,
  buildSeedDropMetadata,
  buildSeedNextCommands,
} from "./cli/index";

describe("CLI semantic seed helpers", () => {
  it("builds a tiny branch-first seed body", () => {
    const content = buildSeedDropContent({
      title: "Branching Guide",
      intent: "Explain branch resolve without a full document dump.",
      labels: ["branching", "semantic-seed"],
    });

    expect(content).toContain("# Branching Guide");
    expect(content).toContain(
      "Intent: Explain branch resolve without a full document dump.",
    );
    expect(content).toContain("`branching`, `semantic-seed`");
    expect(content).toContain("## Sections");
    expect(content).toContain("nd diff apply");
    expect(content).toContain("nd branch memory fact");
    expect(content.length).toBeLessThan(500);
  });

  it("marks seed metadata for retrieval without hiding overrides", () => {
    expect(
      buildSeedDropMetadata(["branching"], { themeId: "dark", owner: "docs" }),
    ).toEqual({
      themeId: "dark",
      docKind: "semantic-seed",
      seed: true,
      retrievalTags: ["branching"],
      owner: "docs",
    });
  });

  it("returns next commands that continue with branch diffs and facts", () => {
    const commands = buildSeedNextCommands("drop_1", "branch_1");

    expect(commands.resolveBranch).toBe("nd branch resolve drop_1 --json");
    expect(commands.appendSection).toContain("nd diff apply drop_1 --branch branch_1");
    expect(commands.appendSection).toContain("agent.edit");
    expect(commands.recordFact).toContain(
      "nd branch memory fact drop_1 branch_1",
    );
  });
});

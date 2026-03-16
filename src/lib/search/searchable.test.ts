import {
  matchesSearchable,
  normalizeSearchQuery,
  type Searchable,
} from "./searchable";

describe("searchable helpers", () => {
  const entity: Searchable<{ id: string }> = {
    id: "draft-1",
    type: "draft",
    title: "Research Notes",
    description: "Updated yesterday",
    keywords: ["drop-123", "notes"],
    value: { id: "1" },
  };

  it("normalizes query casing and whitespace", () => {
    expect(normalizeSearchQuery("  Notes  ")).toBe("notes");
  });

  it("matches across title, description, type, and keywords", () => {
    expect(matchesSearchable(entity, "research")).toBe(true);
    expect(matchesSearchable(entity, "yesterday")).toBe(true);
    expect(matchesSearchable(entity, "draft")).toBe(true);
    expect(matchesSearchable(entity, "drop-123")).toBe(true);
  });

  it("returns true for empty queries", () => {
    expect(matchesSearchable(entity, "")).toBe(true);
    expect(matchesSearchable(entity, "   ")).toBe(true);
  });

  it("returns false for non-matching query", () => {
    expect(matchesSearchable(entity, "diagram")).toBe(false);
  });
});

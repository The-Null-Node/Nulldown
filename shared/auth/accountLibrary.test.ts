import { describe, expect, it } from "@jest/globals";
import { isAccountLibraryPage } from "./accountLibrary";

describe("isAccountLibraryPage", () => {
  it("accepts metadata-only active and deleted entries", () => {
    expect(
      isAccountLibraryPage({
        items: [
          {
            state: "active",
            id: "drop_a",
            visibility: "private",
            createdAt: 1,
            updatedAt: 2,
          },
          { state: "deleted", id: "drop_b", deletedAt: 3 },
        ],
        cursor: "next-page",
      }),
    ).toBe(true);
  });

  it("rejects payload-bearing or malformed entries", () => {
    expect(
      isAccountLibraryPage({
        items: [{ state: "active", id: "drop_a", content: "private text" }],
        cursor: null,
      }),
    ).toBe(false);
    expect(isAccountLibraryPage({ items: [], cursor: 4 })).toBe(false);
  });
});

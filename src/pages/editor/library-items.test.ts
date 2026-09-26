import {
  deriveLibraryGroups,
  type EditorLibrarySnapshot,
} from "./library-items";

it("preserves draft identity and owned/external/remote routing while omitting duplicate external entries", () => {
  const draft = {
    draftKey: "custom-key",
    draftId: "B",
    dropId: "owned123",
    title: "B",
    preview: "draft B",
    updatedAt: 1,
  };
  const library: EditorLibrarySnapshot = {
    drafts: [draft],
    drops: [
      { id: "owned123", visibility: "private", createdAt: 1, updatedAt: 2 },
    ],
    externalDrops: ["owned123", "external123"].map((id) => ({
      id,
      title: id,
      preview: "",
      updatedAt: 1,
    })),
    remoteEntries: [
      {
        state: "active",
        id: "remote123",
        visibility: "public",
        createdAt: 1,
        updatedAt: 2,
      },
      { state: "deleted", id: "deleted123", deletedAt: 3 },
    ],
  };
  const entities = deriveLibraryGroups(library).flatMap(
    (group) => group.entities,
  );
  expect(entities.map((entity) => entity.value)).toEqual([
    { kind: "open-draft", entry: draft },
    { kind: "open-drop", id: "owned123", source: "owned" },
    { kind: "open-drop", id: "external123", source: "external" },
    { kind: "open-drop", id: "remote123", source: "remote" },
  ]);
  expect(library.externalDrops).toHaveLength(2);
});

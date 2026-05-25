/*
EditorPage is the main orchestration layer for the app. It coordinates draft restore,
drop loading, branch bootstrap, diff publishing, library actions, and the offline/online
mode toggle while delegating storage and rendering details to the underlying subsystems.
*/

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import useEditorStore, { type EditorState } from "../stores/editorStore";
import useStorageStore from "../stores/storageStore";
import useDropStore, {
  isOfflineDropId,
  type OwnedDropRecord,
} from "../stores/dropStore";
import { normalizeNetworkAllowlist } from "../lib/networkAllowlist";
import { useDraftStorage } from "../hooks/useLocalStorage";
import EditorToolbar from "./editor/components/EditorToolbar";
import ErrorBanner from "./editor/components/ErrorBanner";
import EditorPane from "./editor/components/EditorPane";
import PreviewPane from "./editor/components/PreviewPane";
import ShareSuccessView from "./editor/components/ShareSuccessView";
import SettingsModal from "./editor/components/SettingsModal";
import LibraryPalette from "./editor/components/LibraryPalette";
import { useShareDrop } from "./editor/hooks/useShareDrop";
import { usePreviewToggle } from "./editor/hooks/usePreviewToggle";
import { useDiffChannel } from "./editor/hooks/useDiffChannel";
import {
  listRecentExternalDrops,
  type RecentExternalDropRecord,
} from "../lib/drop/recentExternalDrops";
import createEditor from "../lib/nulledit/editor";
import { buildDraftPackFromSnapshot } from "../lib/nulledit/draftPack";
import { computeDiffOps } from "../../shared/nulledit/textDiff";
import {
  createDraftStorageKey,
  listDraftLibraryEntries,
  removeDraftLibraryEntry,
  type DraftLibraryEntry,
  upsertDraftLibraryEntry,
} from "../lib/draft/library";
import {
  type Searchable,
  type SearchableGroup,
} from "../lib/search/searchable";
import { toShortDropId } from "../../shared/drop/id";
import { toUserFacingDropError } from "../lib/drop/userErrors";
import { getUnlockedVault } from "../lib/drop/passkeyVault";
import { createBranchApiClient } from "../../shared/drop/branchApi";
import { getAccountSessionToken } from "../lib/auth/accountSession";

type PaletteAction =
  | { kind: "open-drop"; id: string; source: "owned" | "external" }
  | { kind: "open-draft"; entry: DraftLibraryEntry }
  | {
      kind: "insert-block";
      snippet: string;
      selectionStartOffset: number;
      selectionEndOffset: number;
    }
  | { kind: "new-drop" }
  | { kind: "refresh-search" };

type PaletteEntity = Searchable<PaletteAction>;

interface ActiveBranchSession {
  rootDropId: string;
  branchId: string;
  accountId: string;
  clientId: string;
}

const VISIBILITY_CYCLE: Array<"private" | "unlisted" | "public"> = [
  "private",
  "unlisted",
  "public",
];

const nextVisibility = (
  current: "private" | "unlisted" | "public",
): "private" | "unlisted" | "public" => {
  const index = VISIBILITY_CYCLE.indexOf(current);
  const nextIndex = index < 0 ? 0 : (index + 1) % VISIBILITY_CYCLE.length;
  return VISIBILITY_CYCLE[nextIndex];
};

const formatTimestamp = (timestamp: number) => {
  try {
    return new Date(timestamp).toLocaleString();
  } catch {
    return "Unknown";
  }
};

const EditorPage: React.FC = () => {
  const editorRef = useRef<ReturnType<typeof createEditor> | null>(null);
  if (!editorRef.current) {
    editorRef.current = createEditor();
  }
  const editor = editorRef.current;
  const navigate = useNavigate();

  const [searchParams] = useSearchParams();
  const editId = searchParams.get("edit");
  const cloneId = searchParams.get("clone");
  const draftId = searchParams.get("draft");
  const draftKeyParam = searchParams.get("draftKey");
  const routeDropId = editId ?? cloneId;
  const activeDraftId = draftId ?? editId ?? cloneId ?? "scratch";
  const draftStorageKey =
    typeof draftKeyParam === "string" && draftKeyParam.trim()
      ? draftKeyParam
      : createDraftStorageKey(activeDraftId);

  const markdown = useEditorStore((state: EditorState) => state.textContent);
  const renderedMarkdown = useEditorStore(
    (state: EditorState) => state.renderedMarkdown,
  );
  const currentSnapshotId = useEditorStore(
    (state: EditorState) => state.currentSnapshotId,
  );
  const baseDropId = useEditorStore((state: EditorState) => state.baseDropId);
  const setBaseDropId = useEditorStore(
    (state: EditorState) => state.setBaseDropId,
  );

  const bufferRef = useRef(markdown);
  const branchClientIdRef = useRef(
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `branch_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
  );
  const ignoreDraftLoadRef = useRef(false);
  const [existingDropId, setExistingDropId] = useState<string | null>(null);
  const [activeRootDropId, setActiveRootDropId] = useState<string | null>(null);
  const [activeBranchSession, setActiveBranchSession] =
    useState<ActiveBranchSession | null>(null);

  useEffect(() => {
    bufferRef.current = markdown;
  }, [markdown]);

  const initializeStorage = useStorageStore((state) => state.initialize);
  const mode = useDropStore((state) => state.mode);
  const offlineMode = useDropStore((state) => state.offlineMode);

  const diffTargetDropId =
    activeBranchSession?.rootDropId ?? existingDropId ?? editId ?? baseDropId ?? cloneId ?? null;
  const hasDiffTarget = Boolean(diffTargetDropId);
  const shouldWaitForRemoteBranchSession = Boolean(
    routeDropId && !offlineMode && !isOfflineDropId(routeDropId),
  );
  const shouldUseRemoteBranchDiff = Boolean(
    activeBranchSession && !offlineMode && diffTargetDropId && !isOfflineDropId(diffTargetDropId),
  );

  const authTokenProvider = useCallback(
    () => getAccountSessionToken(),
    [],
  );

  const { publishDiffs } = useDiffChannel({
    dropId: diffTargetDropId,
    branchId: activeBranchSession?.branchId,
    accountId: activeBranchSession?.accountId,
    clientId: activeBranchSession?.clientId,
    authTokenProvider,
    isOffline: !shouldUseRemoteBranchDiff,
    editor,
    enabled: shouldWaitForRemoteBranchSession
      ? Boolean(activeBranchSession?.rootDropId)
      : hasDiffTarget,
  });
  const shareVisibility = useDropStore((state) => state.shareVisibility);
  const syntaxMode = useDropStore((state) => state.syntaxMode);
  const allowedUrls = useDropStore((state) => state.allowedUrls);
  const hydrateOfflineMode = useDropStore((state) => state.hydrateOfflineMode);
  const hydrateSharePreferences = useDropStore(
    (state) => state.hydrateSharePreferences,
  );
  const draftDiffPolicy = useDropStore((state) => state.draftDiffPolicy);
  const setMode = useDropStore((state) => state.setMode);
  const setShareVisibility = useDropStore((state) => state.setShareVisibility);
  const getDrop = useDropStore((state) => state.getDrop);
  const resolveDropOwnership = useDropStore(
    (state) => state.resolveDropOwnership,
  );
  const listOwnedDrops = useDropStore((state) => state.listOwnedDrops);
  const setAllowedUrls = useDropStore((state) => state.setAllowedUrls);
  const [modeSwitching, setModeSwitching] = useState(false);

  const setDraftContent = useCallback(
    (value: string) => {
      if (ignoreDraftLoadRef.current) return;
      if (!value) {
        editor.reset();
        return;
      }
      if (!editor.getCurrentSnapshotId()) {
        editor.seedSnapshot(value);
      } else {
        const diffs = computeDiffOps(bufferRef.current, value);
        editor.addDiffs(diffs);
      }
      bufferRef.current = value;
    },
    [editor],
  );

  const { clearDraft: clearDraftStorage, load: loadDraftStorage } =
    useDraftStorage(draftStorageKey, markdown, setDraftContent);

  const clearDraft = useCallback(() => {
    ignoreDraftLoadRef.current = false;
    setExistingDropId(null);
    setActiveRootDropId(null);
    setActiveBranchSession(null);
    setBaseDropId(null);
    editor.reset();
    bufferRef.current = "";
    removeDraftLibraryEntry(draftStorageKey);
    void clearDraftStorage();
  }, [clearDraftStorage, draftStorageKey, editor, setBaseDropId]);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const handleBufferChange = useCallback(
    (nextValue: string) => {
      const prevValue = bufferRef.current;
      if (nextValue === prevValue) return;
      const diffs = computeDiffOps(prevValue, nextValue);
      if (!diffs.length) {
        bufferRef.current = nextValue;
        return;
      }
      editor.addDiffs(diffs);
      publishDiffs(diffs);
      bufferRef.current = nextValue;
    },
    [editor, publishDiffs],
  );

  useEffect(() => {
    void initializeStorage();
    void hydrateOfflineMode();
    void hydrateSharePreferences();
  }, [hydrateOfflineMode, hydrateSharePreferences, initializeStorage]);

  const handleToggleShareVisibility = useCallback(() => {
    void setShareVisibility(nextVisibility(shareVisibility));
  }, [setShareVisibility, shareVisibility]);

  const handleRequestAddNetworkHost = useCallback(
    (host: string) => {
      const normalized = normalizeNetworkAllowlist([host]);
      if (!normalized.length) return;
      const next = normalizeNetworkAllowlist([...allowedUrls, ...normalized]);
      void setAllowedUrls(next);
    },
    [allowedUrls, setAllowedUrls],
  );

  useEffect(() => {
    if (ignoreDraftLoadRef.current) {
      return;
    }

    const timer = window.setTimeout(() => {
      const targetDropId =
        existingDropId ?? editId ?? baseDropId ?? cloneId ?? null;
      upsertDraftLibraryEntry(draftStorageKey, markdown, {
        dropId: targetDropId,
        updatedAt: Date.now(),
      });

      if (!markdown.trim()) {
        removeDraftLibraryEntry(draftStorageKey);
      }
    }, 200);

    return () => {
      window.clearTimeout(timer);
    };
  }, [baseDropId, cloneId, draftStorageKey, editId, existingDropId, markdown]);

  useEffect(() => {
    if (!routeDropId) {
      ignoreDraftLoadRef.current = false;
      setExistingDropId(null);
      setActiveRootDropId(null);
      setActiveBranchSession(null);
      return;
    }

    ignoreDraftLoadRef.current = true;

    const fetchTargetDrop = async () => {
      try {
        const payload = await getDrop(routeDropId);
        if (!payload) {
          throw new Error("Drop not found in local or remote providers.");
        }

        let resolvedDropId = routeDropId;
        let ownedByCurrentAccount = false;

        try {
          const ownership = await resolveDropOwnership(routeDropId);
          if (ownership) {
            resolvedDropId = ownership.id;
            ownedByCurrentAccount = ownership.ownedByCurrentAccount;
          }
        } catch (ownershipError) {
          console.error("Failed to resolve drop ownership:", ownershipError);
        }

        const rootDropId =
          typeof payload.metadata?.rootDropId === "string"
            ? payload.metadata.rootDropId
            : resolvedDropId;
        let content = payload.content;
        let nextBranchSession: ActiveBranchSession | null = null;

        if (!offlineMode && !isOfflineDropId(rootDropId)) {
          try {
            const { accountId } = await getUnlockedVault();
            const branchClient = createBranchApiClient({
              baseUrl: "",
              accountId,
              clientId: branchClientIdRef.current,
              authTokenProvider,
            });
            const branch = await branchClient.resolveBranch(rootDropId);
            const branchContent = await branchClient.getBranchContent(
              branch.rootDropId,
              branch.branchId,
            );

            // Branch content wins over the sealed payload when remote editing is active because the branch
            // stores newer in-progress text than the last promoted/shared drop body.
            content = branchContent.content;
            nextBranchSession = {
              rootDropId: branch.rootDropId,
              branchId: branch.branchId,
              accountId,
              clientId: branchClientIdRef.current,
            };
          } catch (branchError) {
            console.error("Failed to resolve remote branch state:", branchError);
          }
        }

        const shouldEditInPlace = ownedByCurrentAccount;

        editor.reset();
        editor.seedSnapshot(content);
        setActiveRootDropId(rootDropId);
        setActiveBranchSession(nextBranchSession);
        setExistingDropId(shouldEditInPlace ? resolvedDropId : null);
        setBaseDropId(
          shouldEditInPlace
            ? typeof payload.metadata?.baseDropId === "string"
              ? payload.metadata.baseDropId
              : null
            : rootDropId,
        );
        bufferRef.current = content;

        const storedDraft = await loadDraftStorage();
        if (storedDraft && storedDraft.trim() && storedDraft !== content) {
          // Draft storage is local-only and intentionally allowed to override the loaded share target.
          ignoreDraftLoadRef.current = false;
          setDraftContent(storedDraft);
          ignoreDraftLoadRef.current = true;
        }
      } catch (err) {
        console.error(`Failed to ${editId ? "edit" : "clone"} drop:`, err);
      } finally {
        ignoreDraftLoadRef.current = false;
      }
    };

    void fetchTargetDrop();
  }, [
    editId,
    editor,
    getDrop,
    loadDraftStorage,
    resolveDropOwnership,
    authTokenProvider,
    routeDropId,
    setBaseDropId,
    setDraftContent,
  ]);

  const {
    editorHidden,
    isTransitioning,
    resetView,
    setEditMode,
    setPreviewMode,
    showPreview,
  } = usePreviewToggle();

  const renderedFirstMode = syntaxMode === "rendered";
  const [editSurface, setEditSurface] = useState<"source" | "rendered">(
    renderedFirstMode ? "rendered" : "source",
  );

  useEffect(() => {
    setEditSurface(renderedFirstMode ? "rendered" : "source");
  }, [renderedFirstMode]);

  const [cursorSelection, setCursorSelection] = useState({ start: 0, end: 0 });
  const [selectionLocked, setSelectionLocked] = useState(false);
  const prevShowPreviewRef = useRef(showPreview);

  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryDrops, setLibraryDrops] = useState<OwnedDropRecord[]>([]);
  const [libraryExternalDrops, setLibraryExternalDrops] = useState<
    RecentExternalDropRecord[]
  >([]);
  const [libraryDrafts, setLibraryDrafts] = useState<DraftLibraryEntry[]>([]);

  const refreshLibrary = useCallback(async () => {
    setLibraryLoading(true);

    try {
      const [drops, drafts, externalDrops] = await Promise.all([
        listOwnedDrops(),
        Promise.resolve(listDraftLibraryEntries()),
        Promise.resolve(listRecentExternalDrops()),
      ]);
      setLibraryDrops(drops);
      setLibraryDrafts(drafts);
      setLibraryExternalDrops(externalDrops);
    } catch (error) {
      console.error("Failed to load library:", error);
      setLibraryDrops([]);
      setLibraryDrafts([]);
      setLibraryExternalDrops([]);
    } finally {
      setLibraryLoading(false);
    }
  }, [listOwnedDrops]);

  useEffect(() => {
    if (!libraryOpen) {
      return;
    }

    void refreshLibrary();
  }, [libraryOpen, refreshLibrary]);

  const buildDraftPack = useCallback(() => {
    return buildDraftPackFromSnapshot({
      snapshotter: editor.getSnapshotter(),
      snapshotId: editor.getCurrentSnapshotId(),
      // Existing or cloned drops carry lineage-aware draft packs so recipients can inspect edit history.
      policy: draftDiffPolicy,
      source: existingDropId || baseDropId ? "edited-drop" : "new-drop",
    });
  }, [baseDropId, draftDiffPolicy, editor, existingDropId]);

  const {
    error,
    resetShare,
    setError,
    shareDrop,
    sharing,
    successOffline,
    successUrl,
  } = useShareDrop(markdown, clearDraft, {
    baseDropId,
    rootDropId: activeRootDropId,
    existingDropId,
    snapshotId: currentSnapshotId,
    buildDraftPack,
  });

  const [settingsOpen, setSettingsOpen] = useState(false);

  const handleToggleMode = useCallback(() => {
    if (modeSwitching) {
      return;
    }

    const nextMode = mode === "offline" ? "online" : "offline";
    const activeDropId =
      existingDropId ?? editId ?? baseDropId ?? cloneId ?? undefined;

    setModeSwitching(true);

    void (async () => {
      try {
        const result = await setMode(nextMode, {
          activeDropId,
        });

        if (result.publishedDrop) {
          // A mode transition can publish a previously local-only drop and therefore change the canonical id.
          setBaseDropId(result.publishedDrop.id);
        }
      } catch (error) {
        setError(
          toUserFacingDropError(
            error,
            "Couldn't switch modes right now. Please try again.",
          ),
        );
      } finally {
        setModeSwitching(false);
      }
    })();
  }, [
    editId,
    existingDropId,
    baseDropId,
    cloneId,
    mode,
    modeSwitching,
    setBaseDropId,
    setError,
    setMode,
  ]);

  const updateSelection = useCallback(
    (start: number, end: number) => {
      if (selectionLocked) return;
      setCursorSelection({ start, end });
    },
    [selectionLocked],
  );

  const lockSelection = useCallback((start: number, end: number) => {
    setCursorSelection({ start, end });
    setSelectionLocked(true);
  }, []);

  useEffect(() => {
    const wasPreview = prevShowPreviewRef.current;

    if (
      wasPreview &&
      !showPreview &&
      (!renderedFirstMode || editSurface === "source")
    ) {
      const { start, end } = cursorSelection;
      requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;
        textarea.focus();
        textarea.setSelectionRange(start, end);
        if (selectionLocked) {
          setSelectionLocked(false);
        }
      });
    }
    prevShowPreviewRef.current = showPreview;
  }, [
    cursorSelection,
    editSurface,
    renderedFirstMode,
    selectionLocked,
    showPreview,
  ]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setLibraryOpen(true);
        return;
      }

      if (libraryOpen) {
        return;
      }

      const isModifierOnly = e.metaKey || e.ctrlKey || e.altKey;
      const renderedSurfaceVisible =
        renderedFirstMode && !showPreview && editSurface === "rendered";

      if (e.key === "Escape") {
        e.preventDefault();
        if (renderedFirstMode && !showPreview) {
          setEditSurface("rendered");
          return;
        }
        setPreviewMode();
        return;
      }

      if (
        (showPreview || renderedSurfaceVisible) &&
        e.key.toLowerCase() === "i" &&
        !isModifierOnly
      ) {
        e.preventDefault();
        setEditSurface("source");
        setEditMode();
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        if (markdown.trim() && !sharing) {
          shareDrop();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    editSurface,
    libraryOpen,
    markdown,
    renderedFirstMode,
    setEditMode,
    setPreviewMode,
    shareDrop,
    sharing,
    showPreview,
  ]);

  const newDrop = useCallback(() => {
    clearDraft();
    resetShare();
    resetView();
    setEditSurface(renderedFirstMode ? "rendered" : "source");

    if (!renderedFirstMode) {
      setTimeout(() => {
        textareaRef.current?.focus();
      }, 0);
    }
  }, [clearDraft, renderedFirstMode, resetShare, resetView]);

  const openLibrary = useCallback(() => {
    setLibraryOpen(true);
  }, []);

  const insertSnippetFromPalette = useCallback(
    (
      action: Extract<
        PaletteAction,
        {
          kind: "insert-block";
        }
      >,
    ) => {
      const previousValue = bufferRef.current;
      const textarea = textareaRef.current;
      const start = textarea?.selectionStart ?? previousValue.length;
      const end = textarea?.selectionEnd ?? start;

      const nextValue =
        previousValue.slice(0, start) +
        action.snippet +
        previousValue.slice(end);

      handleBufferChange(nextValue);
      setEditSurface("source");
      setEditMode();
      setSelectionLocked(false);

      const selectionStart = Math.max(0, start + action.selectionStartOffset);
      const selectionEnd = Math.max(
        selectionStart,
        start + action.selectionEndOffset,
      );
      setCursorSelection({ start: selectionStart, end: selectionEnd });

      requestAnimationFrame(() => {
        const activeTextarea = textareaRef.current;
        if (!activeTextarea) {
          return;
        }

        activeTextarea.focus();
        activeTextarea.setSelectionRange(selectionStart, selectionEnd);
      });
    },
    [handleBufferChange, setEditMode],
  );

  const searchGroups = useMemo<SearchableGroup<PaletteAction>[]>(() => {
    const embedSnippet = '```embed\nhttps://www.youtube.com/embed/\n```';
    const embedUrlStart = embedSnippet.indexOf("https://");

    const commandEntities: PaletteEntity[] = [
      {
        id: "command-new-drop",
        type: "command",
        title: "New Nulldown",
        description: "Clear this draft and start fresh.",
        keywords: ["new", "scratch", "clear"],
        value: { kind: "new-drop" },
      },
      {
        id: "command-refresh-search",
        type: "command",
        title: "Refresh search index",
        description: "Reload drops and drafts from local storage.",
        keywords: ["refresh", "reload", "index"],
        value: { kind: "refresh-search" },
      },
    ];

    const blockEntities: PaletteEntity[] = [
      {
        id: "block-heading",
        type: "block",
        title: "Insert heading",
        description: "Adds a level-2 heading.",
        keywords: ["header", "h2", "markdown"],
        value: {
          kind: "insert-block",
          snippet: "## Heading",
          selectionStartOffset: 3,
          selectionEndOffset: 10,
        },
      },
      {
        id: "block-image",
        type: "block",
        title: "Insert image",
        description: "Adds markdown image syntax.",
        keywords: ["image", "media", "markdown"],
        value: {
          kind: "insert-block",
          snippet: "![alt](https://)",
          selectionStartOffset: 2,
          selectionEndOffset: 5,
        },
      },
      {
        id: "block-embed",
        type: "block",
        title: "Insert embed block",
        description: "Adds an embed block.",
        keywords: ["embed", "video", "iframe"],
        value: {
          kind: "insert-block",
          snippet: embedSnippet,
          selectionStartOffset: embedUrlStart,
          selectionEndOffset:
            embedUrlStart + "https://www.youtube.com/embed/".length,
        },
      },
    ];

    const draftEntities: PaletteEntity[] = libraryDrafts.map((entry) => ({
      id: `draft-${entry.draftKey}`,
      type: "draft",
      title: entry.title,
      description: `${entry.preview} • Updated ${formatTimestamp(entry.updatedAt)}`,
      keywords: [entry.draftId, entry.dropId ?? ""],
      value: { kind: "open-draft", entry },
    }));

    const ownedDropIds = new Set(libraryDrops.map((entry) => entry.id));

    const ownedDropEntities: PaletteEntity[] = libraryDrops.map((entry) => {
      const shortId = toShortDropId(entry.id);
      const baseDescription = `Owned • ${entry.visibility} • Updated ${formatTimestamp(
        entry.updatedAt,
      )}`;

      return {
        id: `drop-owned-${entry.id}`,
        type: "drop",
        title: `Nulldown ${shortId}`,
        description: baseDescription,
        keywords: [entry.id, shortId, "owned", "edit", entry.visibility],
        value: { kind: "open-drop", id: entry.id, source: "owned" },
      } satisfies PaletteEntity;
    });

    const externalDropEntities: PaletteEntity[] = libraryExternalDrops
      .filter((entry) => !ownedDropIds.has(entry.id))
      .map((entry) => {
        const shortId = toShortDropId(entry.id);
        const baseDescription = entry.preview
          ? `${entry.preview} • External • Viewed ${formatTimestamp(entry.updatedAt)}`
          : `External • Viewed ${formatTimestamp(entry.updatedAt)}`;

        return {
          id: `drop-external-${entry.id}`,
          type: "drop",
          title: entry.title,
          description: baseDescription,
          keywords: [entry.id, shortId, "external", "view"],
          value: { kind: "open-drop", id: entry.id, source: "external" },
        } satisfies PaletteEntity;
      });

    const dropEntities: PaletteEntity[] = [
      ...ownedDropEntities,
      ...externalDropEntities,
    ];

    return [
      {
        id: "commands",
        label: "Commands",
        entities: commandEntities,
      },
      {
        id: "blocks",
        label: "Editor Blocks",
        entities: blockEntities,
      },
      {
        id: "drafts",
        label: "Drafts",
        entities: draftEntities,
      },
      {
        id: "drops",
        label: "Drops",
        entities: dropEntities,
      },
    ].filter((group) => group.entities.length > 0);
  }, [libraryDrafts, libraryDrops, libraryExternalDrops]);

  const handleSelectSearchEntity = useCallback(
    (entity: Searchable<PaletteAction>) => {
      void (async () => {
        switch (entity.value.kind) {
          case "open-drop": {
            if (entity.value.source === "owned") {
              navigate(`/?edit=${encodeURIComponent(entity.value.id)}`);
              return;
            }

            navigate(`/d/${toShortDropId(entity.value.id)}`);
            return;
          }

          case "open-draft": {
            const { entry } = entity.value;
            const params = new URLSearchParams();
            params.set("draft", entry.draftId);
            params.set("draftKey", entry.draftKey);

            if (entry.dropId) {
              try {
                const ownership = await resolveDropOwnership(entry.dropId);
                if (ownership?.ownedByCurrentAccount) {
                  params.set("edit", ownership.id);
                } else {
                  params.set("clone", ownership?.id ?? entry.dropId);
                }
              } catch (ownershipError) {
                console.error(
                  "Failed to resolve draft drop ownership:",
                  ownershipError,
                );
                params.set("clone", entry.dropId);
              }
            }

            navigate(`/?${params.toString()}`);
            return;
          }

          case "insert-block": {
            insertSnippetFromPalette(entity.value);
            return;
          }

          case "new-drop": {
            navigate("/");
            newDrop();
            return;
          }

          case "refresh-search": {
            await refreshLibrary();
            return;
          }

          default:
            return;
        }
      })();
    },
    [
      insertSnippetFromPalette,
      navigate,
      newDrop,
      refreshLibrary,
      resolveDropOwnership,
    ],
  );

  const handlePreviewRequestEdit = useCallback(
    (selection?: { start: number; end: number } | null) => {
      let nextSelection = cursorSelection;

      if (selection) {
        const maxIndex = markdown.length;
        const start = Math.max(0, Math.min(selection.start, maxIndex));
        const end = Math.max(0, Math.min(selection.end, maxIndex));
        lockSelection(start, end);
        nextSelection = { start, end };
      }

      if (renderedFirstMode) {
        setEditSurface("source");
      }

      if (showPreview || renderedFirstMode) {
        setEditMode();
        requestAnimationFrame(() => {
          const textarea = textareaRef.current;
          if (!textarea) {
            return;
          }

          textarea.focus();
          textarea.setSelectionRange(nextSelection.start, nextSelection.end);
          setSelectionLocked(false);
        });
        return;
      }
    },
    [
      cursorSelection,
      lockSelection,
      markdown.length,
      renderedFirstMode,
      setEditMode,
      showPreview,
    ],
  );

  if (successUrl) {
    return (
      <ShareSuccessView
        successUrl={successUrl}
        onCopyError={setError}
        onNewDrop={newDrop}
        offline={successOffline}
      />
    );
  }

  const showSourceEditor =
    !showPreview && (!renderedFirstMode || editSurface === "source");
  const previewVisible =
    showPreview || (renderedFirstMode && editSurface === "rendered");
  const canRequestEdit =
    showPreview || (renderedFirstMode && editSurface === "rendered");

  return (
    <div className="fixed inset-0 flex flex-col">
        <EditorToolbar
          canShare={Boolean(markdown.trim())}
          isTransitioning={isTransitioning}
          offlineMode={offlineMode}
          shareVisibility={shareVisibility}
          sharing={sharing}
          modeSwitching={modeSwitching}
          onToggleMode={handleToggleMode}
          onToggleShareVisibility={handleToggleShareVisibility}
          onOpenLibrary={openLibrary}
          onOpenSettings={() => setSettingsOpen(true)}
          onShare={shareDrop}
        />

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />

      <LibraryPalette
        open={libraryOpen}
        loading={libraryLoading}
        groups={searchGroups}
        onOpenChange={setLibraryOpen}
        onSelectEntity={handleSelectSearchEntity}
        onRefresh={() => {
          void refreshLibrary();
        }}
      />

      <div className="flex-1 relative" style={{ height: "calc(100vh - 65px)" }}>
        {error && <ErrorBanner message={error} />}

        <EditorPane
          visible={showSourceEditor}
          editorState={{ editorHidden }}
          markdown={markdown}
          showPreview={showPreview}
          textareaRef={textareaRef}
          selectionLocked={selectionLocked}
          onChange={handleBufferChange}
          onSelectionChange={updateSelection}
          onExitEdit={() => {
            if (renderedFirstMode) {
              setEditSurface("rendered");
              return;
            }

            setPreviewMode();
          }}
        />

        <PreviewPane
          markdown={renderedMarkdown}
          visible={previewVisible}
          canRequestEdit={canRequestEdit}
          allowedUrls={allowedUrls}
          onRequestEdit={handlePreviewRequestEdit}
          onRequestAddNetworkHost={handleRequestAddNetworkHost}
        />
      </div>
    </div>
  );
};

export default EditorPage;

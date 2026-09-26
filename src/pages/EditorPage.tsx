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
import useEditorStore, { type EditorState } from "../stores/editor-store";
import useStorageStore from "../stores/storage-store";
import useDropStore, { isOfflineDropId } from "../stores/drop-store";
import { normalizeNetworkAllowlist } from "../lib/network-allowlist";
import { useDraftStorage } from "../hooks/use-local-storage";
import EditorToolbar from "./editor/components/EditorToolbar";
import ErrorBanner from "./editor/components/ErrorBanner";
import EditorPane from "./editor/components/EditorPane";
import PreviewPane from "./editor/components/PreviewPane";
import ShareSuccessView from "./editor/components/ShareSuccessView";
import SettingsModal from "./editor/components/SettingsModal";
import LibraryPalette from "./editor/components/LibraryPalette";
import BranchActivityDialog from "./editor/components/BranchActivityDialog";
import BranchSyncBanner from "./editor/components/BranchSyncBanner";
import { useShareDrop } from "./editor/hooks/use-share-drop";
import { usePreviewToggle } from "./editor/hooks/use-preview-toggle";
import { startNewDraft } from "./editor/start-new-draft";
import { useDiffChannel } from "./editor/sync/use-channel";
import { useEditorLibrary } from "./editor/hooks/use-editor-library";
import {
  deriveLibraryGroups,
  type PaletteAction,
} from "./editor/library-items";
import {
  useEditorSession,
  type EditorRouteSession,
} from "./editor/hooks/use-editor-session";
import { buildDraftPackFromSnapshot } from "../lib/nulledit/draft-pack";
import { computeDiffOps } from "../../shared/nulledit/textDiff";
import {
  createDraftStorageKey,
  removeDraftLibraryEntry,
  upsertDraftLibraryEntry,
} from "../lib/draft/library";
import {
  type Searchable,
  type SearchableGroup,
} from "../lib/search/searchable";
import { toShortDropId } from "../../shared/drop/id";
import { toUserFacingDropError } from "../lib/drop/user-errors";
import { getUnlockedVault } from "../lib/auth/vault/passkey-vault";
import { createBranchApiClient } from "../../shared/drop/branch-api";
import { getAccountSessionToken } from "../lib/auth/account-session";
import {
  clearBranchPromotionIntent,
  readBranchPromotionIntent,
  writeBranchPromotionIntent,
  type BranchPromotionIntent,
} from "../lib/branch/promotion-intent";
import type {
  NullplugUiResponseFact,
  NullplugUiStatePatchFact,
} from "../../shared/nullplug/ui";
import {
  createBrowserNullplugClient,
  type BrowserNullplugClient,
} from "../lib/nullplug/browser-client";
import { resolveRootRuntimePolicy } from "../../shared/nullplug/policy";
import { useAccountPreferencesStore } from "../stores/account-preferences-store";

type PaletteEntity = Searchable<PaletteAction>;

interface ActiveBranchSession {
  rootDropId: string;
  branchId: string;
  accountId: string;
  clientId: string;
  headEventSeq: number;
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

const EditorPage: React.FC = () => {
  const [params] = useSearchParams();
  const routeKey = JSON.stringify([
    params.get("edit"),
    params.get("clone"),
    params.get("draft"),
    params.get("draftKey"),
  ]);
  return <EditorRoute key={routeKey} />;
};

const EditorRoute: React.FC = () => {
  const nullplugClientRef = useRef<BrowserNullplugClient | null>(null);
  if (!nullplugClientRef.current) {
    nullplugClientRef.current = createBrowserNullplugClient();
  }
  const nullplugClient = nullplugClientRef.current;
  const session = useEditorSession(nullplugClient);
  return session ? (
    <EditorSessionPage session={session} nullplugClient={nullplugClient} />
  ) : null;
};

const EditorSessionPage: React.FC<{
  session: EditorRouteSession;
  nullplugClient: BrowserNullplugClient;
}> = ({ session, nullplugClient }) => {
  const { editor, isActive } = session;
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
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
  const applyRuntimeFacts = useEditorStore(
    (state: EditorState) => state.applyRuntimeFacts,
  );

  const bufferRef = useRef(markdown);
  const branchClientIdRef = useRef(
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `branch_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
  );
  const promotionIntentRef = useRef<BranchPromotionIntent | null>(null);
  const ignoreDraftLoadRef = useRef(false);
  const runtimePolicyRef =
    useRef<ReturnType<typeof resolveRootRuntimePolicy>>(null);
  const activeBranchSessionRef = useRef<ActiveBranchSession | null>(null);
  const [existingDropId, setExistingDropId] = useState<string | null>(null);
  const [activeRootDropId, setActiveRootDropId] = useState<string | null>(null);
  const [activeBranchSession, setActiveBranchSession] =
    useState<ActiveBranchSession | null>(null);
  const [branchActivityOpen, setBranchActivityOpen] = useState(false);

  useEffect(() => {
    bufferRef.current = markdown;
  }, [markdown]);

  activeBranchSessionRef.current = activeBranchSession;

  const initializeStorage = useStorageStore((state) => state.initialize);
  const mode = useDropStore((state) => state.mode);
  const offlineMode = useDropStore((state) => state.offlineMode);

  const diffTargetDropId =
    activeBranchSession?.rootDropId ??
    existingDropId ??
    editId ??
    baseDropId ??
    cloneId ??
    null;
  const hasDiffTarget = Boolean(diffTargetDropId);
  const shouldWaitForRemoteBranchSession = Boolean(
    routeDropId && !isOfflineDropId(routeDropId),
  );
  const shouldUseRemoteBranchDiff = Boolean(
    activeBranchSession &&
    diffTargetDropId &&
    !isOfflineDropId(diffTargetDropId),
  );

  const authTokenProvider = useCallback(
    (options?: { forceRefresh?: boolean }) => getAccountSessionToken(options),
    [],
  );

  const setDraftContent = useCallback(
    (value: string) => {
      if (!isActive() || ignoreDraftLoadRef.current) return;
      const branchSession = activeBranchSessionRef.current;
      if (!value) {
        editor.reset();
        bufferRef.current = "";
        return;
      }
      editor.reset();
      editor.setRuntimePolicy(runtimePolicyRef.current);
      editor.setRuntimeCaller(
        branchSession
          ? {
              dropId: branchSession.rootDropId,
              branchId: branchSession.branchId,
            }
          : null,
      );
      editor.seedSnapshot(value);
      bufferRef.current = value;
    },
    [editor, isActive],
  );

  const {
    discardSyncConflict,
    flushPendingDiffs,
    publishDiffs,
    syncState,
    takeOverEditing,
  } = useDiffChannel({
    dropId: diffTargetDropId,
    branchId: activeBranchSession?.branchId,
    accountId: activeBranchSession?.accountId,
    clientId: activeBranchSession?.clientId,
    initialHeadSeq: activeBranchSession?.headEventSeq,
    authTokenProvider,
    isOffline: Boolean(activeBranchSession && offlineMode),
    editor,
    onRestoreBranchDraft: setDraftContent,
    onRuntimeFacts: applyRuntimeFacts,
    enabled:
      ready &&
      (shouldWaitForRemoteBranchSession
        ? Boolean(activeBranchSession?.rootDropId)
        : hasDiffTarget),
  });
  const shareVisibility = useDropStore((state) => state.shareVisibility);
  const syntaxMode = useDropStore((state) => state.syntaxMode);
  const allowedUrls = useDropStore((state) => state.allowedUrls);
  const startPublication = useDropStore((state) => state.startPublication);
  const draftDiffPolicy = useDropStore((state) => state.draftDiffPolicy);
  const setMode = useDropStore((state) => state.setMode);
  const setAccountPreference = useAccountPreferencesStore(
    (state) => state.setPreference,
  );
  const getDrop = useDropStore((state) => state.getDrop);
  const resolveDropOwnership = useDropStore(
    (state) => state.resolveDropOwnership,
  );
  const setAllowedUrls = useDropStore((state) => state.setAllowedUrls);
  const [modeSwitching, setModeSwitching] = useState(false);

  const syncLabel =
    syncState.mode === "synced"
      ? "Synced"
      : syncState.mode === "syncing"
        ? `Syncing ${syncState.pendingCount}`
        : syncState.mode === "offline"
          ? `Saved locally${syncState.pendingCount ? ` ${syncState.pendingCount}` : ""}`
          : syncState.mode === "retrying"
            ? `Retrying ${syncState.pendingCount}`
            : syncState.mode === "blocked"
              ? "Sync conflict"
              : syncState.mode === "observer"
                ? "Viewing"
                : null;

  const { clearDraft: clearDraftStorage } = useDraftStorage(
    draftStorageKey,
    markdown,
    setDraftContent,
    { autoSave: ready, autoLoad: false },
  );

  const clearDraft = useCallback(() => {
    if (!isActive()) return;
    ignoreDraftLoadRef.current = false;
    setExistingDropId(null);
    setActiveRootDropId(null);
    setActiveBranchSession(null);
    setBaseDropId(null);
    runtimePolicyRef.current = null;
    editor.reset();
    bufferRef.current = "";
    removeDraftLibraryEntry(draftStorageKey);
    void clearDraftStorage();
  }, [clearDraftStorage, draftStorageKey, editor, isActive, setBaseDropId]);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const handleBufferChange = useCallback(
    (nextValue: string) => {
      if (
        !isActive() ||
        !ready ||
        (shouldWaitForRemoteBranchSession &&
          (!activeBranchSession ||
            !syncState.canEdit ||
            syncState.mode === "inactive"))
      )
        return;
      const previousValue = bufferRef.current;
      if (nextValue === previousValue) return;
      const diffs = computeDiffOps(previousValue, nextValue);
      if (!diffs.length) {
        bufferRef.current = nextValue;
        return;
      }
      if (!shouldUseRemoteBranchDiff) {
        editor.addDiffs(diffs);
        bufferRef.current = nextValue;
        void publishDiffs(diffs, { draftContent: nextValue });
        return;
      }
      // Advance the local diff base before the async durable write so rapid input derives
      // each event from the immediately preceding text instead of a stale buffer.
      bufferRef.current = nextValue;
      editor.addDiffs(diffs);
      void publishDiffs(diffs, { draftContent: nextValue }).catch(() => {
        // Keep the visible local text intact; the branch hook switches this editor read-only.
      });
    },
    [
      editor,
      publishDiffs,
      shouldUseRemoteBranchDiff,
      isActive,
      ready,
      shouldWaitForRemoteBranchSession,
      activeBranchSession,
      syncState.canEdit,
      syncState.mode,
    ],
  );

  useEffect(() => {
    void initializeStorage();
    void startPublication().catch((error) => {
      if (isActive())
        setLoadError(
          toUserFacingDropError(error, "Unable to initialize editor settings."),
        );
    });
  }, [startPublication, initializeStorage, isActive]);

  const handleToggleShareVisibility = useCallback(() => {
    void setAccountPreference(
      "shareVisibilityDefault",
      nextVisibility(shareVisibility),
    );
  }, [setAccountPreference, shareVisibility]);

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
    if (!ready || ignoreDraftLoadRef.current) {
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
  }, [
    baseDropId,
    cloneId,
    draftStorageKey,
    editId,
    existingDropId,
    markdown,
    ready,
  ]);

  useEffect(() => {
    setBranchActivityOpen(false);
  }, [activeBranchSession?.branchId, activeBranchSession?.rootDropId]);

  useEffect(() => {
    let cancelled = false;
    const current = () => !cancelled && isActive();
    setReady(false);
    setLoadError(null);
    ignoreDraftLoadRef.current = true;

    const fetchTargetDrop = async () => {
      try {
        await initializeStorage();
        if (!current()) return;
        if (!routeDropId) {
          const draft = await useStorageStore
            .getState()
            .getItem(draftStorageKey, { throwOnError: true });
          if (!current()) return;
          editor.reset();
          setBaseDropId(null);
          editor.seedSnapshot(draft ?? "");
          bufferRef.current = draft ?? "";
          setReady(true);
          return;
        }
        const payload = await getDrop(routeDropId);
        if (!current()) return;
        if (!payload) {
          throw new Error("Drop not found in local or remote providers.");
        }

        let resolvedDropId = routeDropId;
        let ownedByCurrentAccount = false;

        try {
          const ownership = await resolveDropOwnership(routeDropId);
          if (!current()) return;
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

        if (!isOfflineDropId(rootDropId)) {
          try {
            const { accountId } = await getUnlockedVault();
            if (!current()) return;
            const branchClient = createBranchApiClient({
              baseUrl: "",
              accountId,
              clientId: branchClientIdRef.current,
              authTokenProvider,
            });
            const branch = await branchClient.resolveBranch(rootDropId);
            if (!current()) return;
            const branchContent = await branchClient.getBranchContent(
              branch.rootDropId,
              branch.branchId,
            );
            if (!current()) return;

            // Branch content wins over the sealed payload when remote editing is active because the branch
            // stores newer in-progress text than the last promoted/shared drop body.
            content = branchContent.content;
            nextBranchSession = {
              rootDropId: branch.rootDropId,
              branchId: branch.branchId,
              accountId,
              clientId: branchClientIdRef.current,
              headEventSeq: branchContent.headEventSeq ?? -1,
            };
          } catch (branchError) {
            console.error(
              "Failed to resolve remote branch state:",
              branchError,
            );
          }
        }

        const shouldEditInPlace = ownedByCurrentAccount;

        // Preserve target precedence: branch head over payload, nonblank local
        // draft over either. Durable pending drafts restore after sync starts.
        const storedDraft = await useStorageStore
          .getState()
          .getItem(draftStorageKey, { throwOnError: true });
        if (!current()) return;
        if (storedDraft?.trim()) content = storedDraft;

        editor.reset();
        runtimePolicyRef.current = resolveRootRuntimePolicy(payload.metadata);
        editor.setRuntimePolicy(runtimePolicyRef.current);
        editor.setRuntimeCaller({
          dropId: rootDropId,
          branchId: nextBranchSession?.branchId,
        });
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

        setReady(true);
      } catch (err) {
        if (!current()) return;
        setLoadError(
          toUserFacingDropError(err, "Unable to load this editor draft."),
        );
        console.error(`Failed to ${editId ? "edit" : "clone"} drop:`, err);
      } finally {
        if (current()) ignoreDraftLoadRef.current = false;
      }
    };

    void fetchTargetDrop();
    return () => {
      cancelled = true;
    };
  }, [
    editId,
    editor,
    getDrop,
    draftStorageKey,
    initializeStorage,
    isActive,
    resolveDropOwnership,
    authTokenProvider,
    routeDropId,
    setBaseDropId,
    setDraftContent,
  ]);

  const {
    editorHidden,
    isTransitioning,
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
  const {
    library,
    loading: libraryLoading,
    error: libraryRefreshError,
    refresh: refreshLibrary,
  } = useEditorLibrary(libraryOpen);

  const buildDraftPack = useCallback(
    (policy = draftDiffPolicy) => {
      return buildDraftPackFromSnapshot({
        snapshotter: editor.getSnapshotter(),
        snapshotId: editor.getCurrentSnapshotId(),
        // Existing or cloned drops carry lineage-aware draft packs so recipients can inspect edit history.
        policy,
        source: existingDropId || baseDropId ? "edited-drop" : "new-drop",
      });
    },
    [baseDropId, draftDiffPolicy, editor, existingDropId],
  );

  const publishActiveBranch = useCallback(async () => {
    if (!isActive() || !ready) throw new Error("Editor is not ready.");
    if (!activeBranchSession || !shouldUseRemoteBranchDiff) {
      throw new Error("No remote branch is active for publishing.");
    }

    await flushPendingDiffs();
    if (!isActive()) throw new Error("Editor route changed.");

    const branchClient = createBranchApiClient({
      baseUrl: "",
      accountId: activeBranchSession.accountId,
      clientId: activeBranchSession.clientId,
      authTokenProvider,
    });
    const priorIntent = promotionIntentRef.current;
    let promotionIntent =
      priorIntent &&
      priorIntent.rootDropId === activeBranchSession.rootDropId &&
      priorIntent.branchId === activeBranchSession.branchId
        ? priorIntent
        : readBranchPromotionIntent(
            activeBranchSession.rootDropId,
            activeBranchSession.branchId,
          );
    if (!promotionIntent) {
      const branchContent = await branchClient.getBranchContent(
        activeBranchSession.rootDropId,
        activeBranchSession.branchId,
      );
      promotionIntent = {
        rootDropId: activeBranchSession.rootDropId,
        branchId: activeBranchSession.branchId,
        snapshotId: branchContent.snapshotId,
        idempotencyKey:
          typeof crypto !== "undefined" && crypto.randomUUID
            ? crypto.randomUUID()
            : `promotion_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      };
      writeBranchPromotionIntent(promotionIntent);
    }
    promotionIntentRef.current = promotionIntent;
    try {
      const promoted = await branchClient.promoteBranch(
        activeBranchSession.rootDropId,
        activeBranchSession.branchId,
        {
          expectedSnapshotId: promotionIntent.snapshotId,
          idempotencyKey: promotionIntent.idempotencyKey,
        },
      );
      promotionIntentRef.current = null;
      clearBranchPromotionIntent(
        activeBranchSession.rootDropId,
        activeBranchSession.branchId,
      );
      return { url: promoted.url, offline: false };
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.includes("promotion_head_mismatch") ||
          error.message.includes('"code":"promotion_head_mismatch"'))
      ) {
        promotionIntentRef.current = null;
        clearBranchPromotionIntent(
          activeBranchSession.rootDropId,
          activeBranchSession.branchId,
        );
      }
      throw error;
    }
  }, [
    activeBranchSession,
    authTokenProvider,
    flushPendingDiffs,
    shouldUseRemoteBranchDiff,
    isActive,
    ready,
  ]);

  const {
    error,
    setError,
    shareDrop,
    sharing,
    successKind,
    successOffline,
    successUrl,
  } = useShareDrop(markdown, clearDraft, {
    isActive,
    canShare:
      ready &&
      (!shouldWaitForRemoteBranchSession ||
        Boolean(
          activeBranchSession &&
          syncState.canEdit &&
          syncState.mode !== "inactive",
        )),
    baseDropId,
    rootDropId: activeRootDropId,
    existingDropId,
    snapshotId: currentSnapshotId,
    buildDraftPack,
    publishBranch: shouldUseRemoteBranchDiff ? publishActiveBranch : undefined,
  });

  const recoverWithRemoteBranch = useCallback(() => {
    if (!activeBranchSession) return;

    void (async () => {
      try {
        const branchClient = createBranchApiClient({
          baseUrl: "",
          accountId: activeBranchSession.accountId,
          clientId: activeBranchSession.clientId,
          authTokenProvider,
        });
        const branch = await branchClient.getBranchContent(
          activeBranchSession.rootDropId,
          activeBranchSession.branchId,
        );
        if (!isActive()) return;
        await discardSyncConflict();
        if (!isActive()) return;
        editor.reset();
        editor.setRuntimePolicy(runtimePolicyRef.current);
        editor.setRuntimeCaller({
          dropId: activeBranchSession.rootDropId,
          branchId: activeBranchSession.branchId,
        });
        editor.seedSnapshot(branch.content);
        bufferRef.current = branch.content;
        setActiveBranchSession((current) =>
          current
            ? {
                ...current,
                headEventSeq: branch.headEventSeq ?? -1,
              }
            : current,
        );
      } catch (recoveryError) {
        if (!isActive()) return;
        setError(
          recoveryError instanceof Error
            ? recoveryError.message
            : "Unable to load the current remote branch.",
        );
      }
    })();
  }, [
    activeBranchSession,
    authTokenProvider,
    discardSyncConflict,
    editor,
    setError,
    isActive,
  ]);

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
        if (!isActive()) return;

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
    isActive,
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
    if (!isActive() || !ready) return;
    try {
      startNewDraft({
        draftKey: draftStorageKey,
        content: bufferRef.current,
        dropId: existingDropId ?? editId ?? baseDropId ?? cloneId ?? null,
        navigate,
      });
    } catch (error) {
      setError(
        toUserFacingDropError(error, "Unable to save the current draft."),
      );
    }
  }, [
    isActive,
    ready,
    draftStorageKey,
    existingDropId,
    editId,
    baseDropId,
    cloneId,
    navigate,
    setError,
  ]);

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
    const embedSnippet = "```embed\nhttps://www.youtube.com/embed/\n```";
    const embedUrlStart = embedSnippet.indexOf("https://");
    const approvalSnippet =
      '```approval(id="release-approval")\nApprove this action?\n```';
    const approvalIdStart = approvalSnippet.indexOf("release-approval");

    const commandEntities: PaletteEntity[] = [
      {
        id: "command-new-drop",
        type: "command",
        title: "New Nulldown",
        description: "Save this draft and start a new document.",
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
      {
        id: "block-approval",
        type: "block",
        title: "Insert approval block",
        description:
          "Records an authenticated human decision as a branch fact.",
        keywords: ["approval", "decision", "human", "nullplug"],
        value: {
          kind: "insert-block",
          snippet: approvalSnippet,
          selectionStartOffset: approvalIdStart,
          selectionEndOffset: approvalIdStart + "release-approval".length,
        },
      },
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
      ...deriveLibraryGroups(library),
    ].filter((group) => group.entities.length > 0);
  }, [library]);

  const handleSelectSearchEntity = useCallback(
    (entity: Searchable<PaletteAction>) => {
      if (!isActive()) return;
      void (async () => {
        switch (entity.value.kind) {
          case "open-drop": {
            if (
              entity.value.source === "owned" ||
              entity.value.source === "remote"
            ) {
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

            if (!isActive()) return;
            navigate(`/?${params.toString()}`);
            return;
          }

          case "insert-block": {
            insertSnippetFromPalette(entity.value);
            return;
          }

          case "new-drop": {
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
      isActive,
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

  const handleSubmitNullplugResponse = useCallback(
    async (fact: NullplugUiResponseFact) => {
      if (!activeBranchSession) {
        throw new Error(
          "A remote branch session is required for approval responses.",
        );
      }
      if (
        fact.source.rootDropId !== activeBranchSession.rootDropId ||
        fact.source.branchId !== activeBranchSession.branchId
      ) {
        throw new Error(
          "The approval response does not match the active branch.",
        );
      }

      await nullplugClient.submitResponse(
        {
          rootDropId: activeBranchSession.rootDropId,
          branchId: activeBranchSession.branchId,
          accountId: activeBranchSession.accountId,
          clientId: activeBranchSession.clientId,
        },
        fact,
      );
    },
    [activeBranchSession, nullplugClient],
  );

  const handleSubmitNullplugState = useCallback(
    async (fact: NullplugUiStatePatchFact) => {
      if (!activeBranchSession) {
        throw new Error("A remote branch session is required for UI state.");
      }
      if (
        fact.source.rootDropId !== activeBranchSession.rootDropId ||
        fact.source.branchId !== activeBranchSession.branchId
      ) {
        throw new Error("The UI state does not match the active branch.");
      }

      await nullplugClient.submitState(
        {
          rootDropId: activeBranchSession.rootDropId,
          branchId: activeBranchSession.branchId,
          accountId: activeBranchSession.accountId,
          clientId: activeBranchSession.clientId,
        },
        fact,
      );
    },
    [activeBranchSession, nullplugClient],
  );

  if (successUrl) {
    return (
      <ShareSuccessView
        successUrl={successUrl}
        onCopyError={setError}
        onNewDrop={newDrop}
        offline={successOffline}
        kind={successKind}
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
        canOpenBranches={Boolean(activeBranchSession && !offlineMode)}
        isTransitioning={isTransitioning}
        offlineMode={offlineMode}
        shareVisibility={shareVisibility}
        syncLabel={syncLabel}
        syncTitle={syncState.message}
        canTakeOverBranch={syncState.mode === "observer"}
        shareLabel={
          shouldUseRemoteBranchDiff ? "Publish Branch" : "Share to the Void"
        }
        sharingLabel={
          shouldUseRemoteBranchDiff ? "Publishing..." : "Sharing..."
        }
        sharing={sharing}
        modeSwitching={modeSwitching}
        onToggleMode={handleToggleMode}
        onToggleShareVisibility={handleToggleShareVisibility}
        onOpenLibrary={openLibrary}
        onOpenBranches={() => setBranchActivityOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onSyncReady={() => window.location.reload()}
        onTakeOverBranch={() => {
          void takeOverEditing().catch((takeOverError) => {
            setError(
              takeOverError instanceof Error
                ? takeOverError.message
                : "Unable to take over this branch.",
            );
          });
        }}
        onShare={shareDrop}
      />

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />

      {activeBranchSession ? (
        <BranchActivityDialog
          open={branchActivityOpen}
          onOpenChange={setBranchActivityOpen}
          rootDropId={activeBranchSession.rootDropId}
          activeBranchId={activeBranchSession.branchId}
          activeContent={markdown}
          accountId={activeBranchSession.accountId}
          clientId={activeBranchSession.clientId}
          authTokenProvider={authTokenProvider}
        />
      ) : null}

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

      {libraryRefreshError ? (
        <ErrorBanner message={libraryRefreshError} />
      ) : null}

      <div className="flex-1 relative" style={{ height: "calc(100vh - 65px)" }}>
        {(loadError || error) && <ErrorBanner message={loadError || error!} />}
        <BranchSyncBanner
          state={syncState}
          onUseRemoteBranch={recoverWithRemoteBranch}
        />

        <EditorPane
          visible={showSourceEditor}
          editorState={{
            editorHidden,
            syncReadOnly: Boolean(
              !ready ||
              (shouldWaitForRemoteBranchSession && !activeBranchSession) ||
              (activeBranchSession &&
                (syncState.mode === "inactive" || !syncState.canEdit)),
            ),
          }}
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
          onSubmitNullplugResponse={
            activeBranchSession ? handleSubmitNullplugResponse : undefined
          }
          onSubmitNullplugState={
            activeBranchSession ? handleSubmitNullplugState : undefined
          }
        />
      </div>
    </div>
  );
};

export default EditorPage;

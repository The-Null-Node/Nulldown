import React, { useEffect, useMemo, useState } from "react";
import {
  useTheme,
  useThemeCatalog,
  useTypefaceCatalog,
} from "../../../theme/themeContext";
import type {
  TypefaceDefinition,
  TypefaceId,
} from "../../../theme/typefaceCatalog";
import useDropStore, {
  type EditorSyntaxMode,
} from "../../../stores/dropStore";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import {
  DEFAULT_IFRAME_ALLOWLIST,
  normalizeIframeAllowlist,
  parseIframeAllowlistInput,
} from "../../../lib/iframeAllowlist";

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

type ThemeOption = {
  id: string;
  name: string;
};

type ShareVisibility = "unlisted" | "public";
type UnlockPolicy = "vault-only" | "provider-escrow";
type SyncTargetProvider = "local" | "remote";
type DraftDiffPolicy = "edited-only" | "always";

const SECTION_TITLE_CLASS =
  "text-base leading-tight font-semibold tracking-tight text-foreground";
const FIELD_LABEL_CLASS = "text-[11px] font-medium tracking-wide text-muted";

interface SettingsSectionProps {
  title: string;
  children: React.ReactNode;
  compact?: boolean;
}

const SettingsSection: React.FC<SettingsSectionProps> = ({
  title,
  children,
  compact = false,
}) => (
  <section className={compact ? "space-y-2" : "space-y-3"}>
    <h3 className={SECTION_TITLE_CLASS}>{title}</h3>
    {children}
  </section>
);

interface ThemeSectionProps {
  themeId: string;
  themeOptions: ThemeOption[];
  onThemeChange: (id: string) => void;
}

const ThemeSection: React.FC<ThemeSectionProps> = ({
  themeId,
  themeOptions,
  onThemeChange,
}) => (
  <SettingsSection title="Theme">
    <div className="space-y-2">
      <Label htmlFor="theme-select" className={FIELD_LABEL_CLASS}>
        UI theme
      </Label>
      <Select
        value={themeId}
        onValueChange={(value) => {
          if (typeof value === "string") {
            onThemeChange(value);
          }
        }}
      >
        <SelectTrigger id="theme-select" className="w-full justify-between">
          <SelectValue placeholder="Select theme" />
        </SelectTrigger>
        <SelectContent>
          {themeOptions.map((option) => (
            <SelectItem key={option.id} value={option.id}>
              {option.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  </SettingsSection>
);

interface TypographySectionProps {
  typefaceId: TypefaceId;
  typefaces: readonly TypefaceDefinition[];
  activeTypeface: TypefaceDefinition;
  onTypefaceChange: (id: TypefaceId) => void;
}

const TypographySection: React.FC<TypographySectionProps> = ({
  typefaceId,
  typefaces,
  activeTypeface,
  onTypefaceChange,
}) => (
  <SettingsSection title="Typography">
    <div className="space-y-2">
      <Label htmlFor="typeface-select" className={FIELD_LABEL_CLASS}>
        Typeface
      </Label>
      <Select
        value={typefaceId}
        onValueChange={(value) => {
          if (typeof value !== "string") {
            return;
          }

          const match = typefaces.find((typeface) => typeface.id === value);
          if (match) {
            onTypefaceChange(match.id);
          }
        }}
      >
        <SelectTrigger id="typeface-select" className="w-full justify-between">
          <SelectValue placeholder="Select typeface" />
        </SelectTrigger>
        <SelectContent>
          {typefaces.map((typeface) => (
            <SelectItem key={typeface.id} value={typeface.id}>
              {typeface.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted">{activeTypeface.description}</p>
    </div>
  </SettingsSection>
);

interface EditorSectionProps {
  syntaxMode: EditorSyntaxMode;
  onSyntaxModeChange: (mode: EditorSyntaxMode) => void;
}

const EditorSection: React.FC<EditorSectionProps> = ({
  syntaxMode,
  onSyntaxModeChange,
}) => (
  <SettingsSection title="Editor">
    <div className="space-y-2">
      <Label htmlFor="syntax-mode-select" className={FIELD_LABEL_CLASS}>
        Syntax mode
      </Label>
      <Select
        value={syntaxMode}
        onValueChange={(value) => {
          if (value === "rendered" || value === "source") {
            onSyntaxModeChange(value);
          }
        }}
      >
        <SelectTrigger id="syntax-mode-select" className="w-full justify-between">
          <SelectValue placeholder="Select syntax mode" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="rendered">Rendered-first (default)</SelectItem>
          <SelectItem value="source">Source markdown</SelectItem>
        </SelectContent>
      </Select>
      <p className="text-xs text-muted">
        Rendered-first mode shows formatted output in edit mode, then drops into
        source markdown when you start editing.
      </p>
    </div>
  </SettingsSection>
);

interface AccessSectionProps {
  offlineMode: boolean;
  shareVisibility: ShareVisibility;
  syncTargetProvider: SyncTargetProvider;
  unlockPolicy: UnlockPolicy;
  draftDiffPolicy: DraftDiffPolicy;
  onShareVisibilityChange: (visibility: ShareVisibility) => void;
  onSyncTargetProviderChange: (provider: SyncTargetProvider) => void;
  onUnlockPolicyChange: (policy: UnlockPolicy) => void;
  onDraftDiffPolicyChange: (policy: DraftDiffPolicy) => void;
}

const AccessSection: React.FC<AccessSectionProps> = ({
  offlineMode,
  shareVisibility,
  syncTargetProvider,
  unlockPolicy,
  draftDiffPolicy,
  onShareVisibilityChange,
  onSyncTargetProviderChange,
  onUnlockPolicyChange,
  onDraftDiffPolicyChange,
}) => (
  <SettingsSection title="Access">
    <div className="rounded-md border border-border bg-background px-3 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="text-sm font-medium text-foreground">Link visibility</div>
          <div className="text-xs text-muted">
            {offlineMode
              ? "Link visibility is online-only and unavailable while offline mode is enabled."
              : shareVisibility === "public"
                ? "Public links can be indexed and discovered."
                : "Unlisted links are only accessible to people with the URL."}
          </div>
        </div>

        <Switch
          checked={shareVisibility === "public"}
          disabled={offlineMode}
          onCheckedChange={(checked) => {
            if (offlineMode) {
              return;
            }

            onShareVisibilityChange(checked ? "public" : "unlisted");
          }}
          aria-label="Toggle link visibility"
        />
      </div>
    </div>

    {!offlineMode ? (
      <>
        <div className="space-y-2">
          <Label htmlFor="sync-target-select" className={FIELD_LABEL_CLASS}>
            Sync target provider
          </Label>
          <Select
            value={syncTargetProvider}
            onValueChange={(value) => {
              if (value === "local" || value === "remote") {
                onSyncTargetProviderChange(value);
              }
            }}
          >
            <SelectTrigger id="sync-target-select" className="w-full justify-between">
              <SelectValue placeholder="Select sync target" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="remote">Remote provider (R2)</SelectItem>
              <SelectItem value="local">Local-only provider</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="unlock-policy-select" className={FIELD_LABEL_CLASS}>
            Unlock policy
          </Label>
          <Select
            value={unlockPolicy}
            onValueChange={(value) => {
              if (value === "vault-only" || value === "provider-escrow") {
                onUnlockPolicyChange(value);
              }
            }}
          >
            <SelectTrigger id="unlock-policy-select" className="w-full justify-between">
              <SelectValue placeholder="Select unlock policy" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="vault-only">Vault only (single-account)</SelectItem>
              <SelectItem value="provider-escrow">
                Provider escrow (multi-key unlock)
              </SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted">
            {unlockPolicy === "provider-escrow"
              ? "Provider stores escrowed key material while content remains encrypted."
              : "Only your local account vault key can unwrap this drop."}
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="draft-diff-policy-select" className={FIELD_LABEL_CLASS}>
            Snapshot diff storage
          </Label>
          <Select
            value={draftDiffPolicy}
            onValueChange={(value) => {
              if (value === "edited-only" || value === "always") {
                onDraftDiffPolicyChange(value);
              }
            }}
          >
            <SelectTrigger
              id="draft-diff-policy-select"
              className="w-full justify-between"
            >
              <SelectValue placeholder="Select diff policy" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="edited-only">Edited drops only</SelectItem>
              <SelectItem value="always">Always store snapshot diffs</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted">
            {draftDiffPolicy === "always"
              ? "Include encrypted snapshot diff data in every shared drop."
              : "Include encrypted snapshot diff data only when editing an existing drop."}
          </p>
        </div>
      </>
    ) : (
      <p className="text-xs text-muted">
        Remote provider and unlock settings are hidden while offline mode is
        enabled.
      </p>
    )}
  </SettingsSection>
);

interface EmbedsSectionProps {
  allowedUrls: readonly string[];
  onAllowedUrlsChange: (urls: readonly string[]) => void;
}

const EmbedsSection: React.FC<EmbedsSectionProps> = ({
  allowedUrls,
  onAllowedUrlsChange,
}) => {
  const [draftValue, setDraftValue] = useState(allowedUrls.join("\n"));

  useEffect(() => {
    setDraftValue(allowedUrls.join("\n"));
  }, [allowedUrls]);

  const parsedAllowlist = useMemo(
    () => parseIframeAllowlistInput(draftValue),
    [draftValue],
  );

  const activeAllowlist = useMemo(
    () => normalizeIframeAllowlist(allowedUrls),
    [allowedUrls],
  );

  const hasChanges =
    parsedAllowlist.join("\n") !== activeAllowlist.join("\n");

  return (
    <SettingsSection title="Embeds">
      <div className="space-y-2">
        <Label htmlFor="allowed-urls-input" className={FIELD_LABEL_CLASS}>
          Allowed URLs
        </Label>
        <textarea
          id="allowed-urls-input"
          value={draftValue}
          onChange={(event) => {
            setDraftValue(event.target.value);
          }}
          spellCheck={false}
          rows={6}
          className="w-full rounded-md border border-input bg-transparent px-2.5 py-2 text-sm text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          placeholder={DEFAULT_IFRAME_ALLOWLIST.join("\n")}
        />
        <p className="text-xs text-muted">
          One URL or host per line. Only these URLs are allowed for embeds.
        </p>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            disabled={!hasChanges}
            onClick={() => {
              onAllowedUrlsChange(parsedAllowlist);
            }}
          >
            Apply
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              const defaults = [...DEFAULT_IFRAME_ALLOWLIST];
              setDraftValue(defaults.join("\n"));
              onAllowedUrlsChange(defaults);
            }}
          >
            Reset Defaults
          </Button>
        </div>
      </div>
    </SettingsSection>
  );
};

const ShortcutsSection: React.FC = () => (
  <SettingsSection title="Shortcuts" compact>
    <div className="space-y-1 text-sm text-foreground">
      <div className="flex items-center justify-between">
        <span>Open search</span>
        <span className="text-xs text-muted">Cmd/Ctrl + K</span>
      </div>
      <div className="flex items-center justify-between">
        <span>Share drop</span>
        <span className="text-xs text-muted">Cmd/Ctrl + Enter</span>
      </div>
      <div className="flex items-center justify-between">
        <span>Focus preview</span>
        <span className="text-xs text-muted">Esc</span>
      </div>
      <div className="flex items-center justify-between">
        <span>Underline selection</span>
        <span className="text-xs text-muted">Cmd/Ctrl + U</span>
      </div>
    </div>
  </SettingsSection>
);

interface StorageSectionProps {
  offlineMode: boolean;
  onOfflineModeChange: (enabled: boolean) => void;
}

const StorageSection: React.FC<StorageSectionProps> = ({
  offlineMode,
  onOfflineModeChange,
}) => (
  <SettingsSection title="Storage">
    <p className="text-sm text-foreground">
      Drafts are saved locally in your browser while you type.
    </p>

    <div className="rounded-md border border-border bg-background px-3 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="text-sm font-medium text-foreground">Offline mode</div>
          <div className="text-xs text-muted">
            {offlineMode
              ? "Drops are encrypted and saved locally to IndexedDB on this browser profile."
              : "Drops are end-to-end encrypted, uploaded online, and unlocked with your passkey vault."}
          </div>
        </div>

        <Switch
          checked={offlineMode}
          onCheckedChange={(checked) => {
            onOfflineModeChange(Boolean(checked));
          }}
          aria-label="Toggle offline mode"
        />
      </div>

      <div className="mt-3 text-xs text-muted">
        Current mode: {offlineMode ? "Offline" : "Online"}
      </div>

      <div className="mt-1 text-xs text-muted">
        {offlineMode
          ? "Offline links are local-only and work in this browser profile."
          : "Online links require your account vault unlock to decrypt."}
      </div>
    </div>
  </SettingsSection>
);

const SettingsModal: React.FC<SettingsModalProps> = ({ open, onClose }) => {
  const { themeId, setThemeId, typefaceId, setTypefaceId } = useTheme();
  const catalog = useThemeCatalog();
  const typefaces = useTypefaceCatalog();
  const offlineMode = useDropStore((state) => state.offlineMode);
  const syncTargetProvider = useDropStore((state) => state.syncTargetProvider);
  const shareVisibility = useDropStore((state) => state.shareVisibility);
  const unlockPolicy = useDropStore((state) => state.unlockPolicy);
  const draftDiffPolicy = useDropStore((state) => state.draftDiffPolicy);
  const syntaxMode = useDropStore((state) => state.syntaxMode);
  const allowedUrls = useDropStore((state) => state.allowedUrls);
  const setOfflineMode = useDropStore((state) => state.setOfflineMode);
  const setSyncTargetProvider = useDropStore(
    (state) => state.setSyncTargetProvider,
  );
  const setShareVisibility = useDropStore((state) => state.setShareVisibility);
  const setUnlockPolicy = useDropStore((state) => state.setUnlockPolicy);
  const setDraftDiffPolicy = useDropStore((state) => state.setDraftDiffPolicy);
  const setSyntaxMode = useDropStore((state) => state.setSyntaxMode);
  const setAllowedUrls = useDropStore((state) => state.setAllowedUrls);
  const hydrateOfflineMode = useDropStore((state) => state.hydrateOfflineMode);
  const hydrateSharePreferences = useDropStore(
    (state) => state.hydrateSharePreferences,
  );

  const themeOptions = useMemo(
    () => [
      { id: "system", name: "System" },
      ...catalog.map((theme) => ({ id: theme.id, name: theme.name })),
    ],
    [catalog],
  );

  const activeTypeface = useMemo(
    () =>
      typefaces.find((typeface) => typeface.id === typefaceId) ?? typefaces[0],
    [typefaceId, typefaces],
  );

  useEffect(() => {
    if (!open) return;
    void hydrateOfflineMode();
    void hydrateSharePreferences();
  }, [open, hydrateOfflineMode, hydrateSharePreferences]);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          onClose();
        }
      }}
    >
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] w-[min(40rem,calc(100vw-2rem))] max-w-none flex-col overflow-hidden rounded-lg border border-border bg-card p-0 text-foreground sm:max-h-[calc(100dvh-3rem)]">
        <DialogHeader className="shrink-0 border-b border-border px-5 py-4">
          <DialogTitle className="text-lg leading-tight font-semibold">
            Settings
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <div className="space-y-6">
            <ThemeSection
              themeId={themeId}
              themeOptions={themeOptions}
              onThemeChange={(id) => {
                void setThemeId(id);
              }}
            />

            <TypographySection
              typefaceId={typefaceId}
              typefaces={typefaces}
              activeTypeface={activeTypeface}
              onTypefaceChange={(id) => {
                setTypefaceId(id);
              }}
            />

            <Separator className="bg-border" />

            <EditorSection
              syntaxMode={syntaxMode}
              onSyntaxModeChange={(mode) => {
                void setSyntaxMode(mode);
              }}
            />

            <Separator className="bg-border" />

            <AccessSection
              offlineMode={offlineMode}
              shareVisibility={shareVisibility}
              syncTargetProvider={syncTargetProvider}
              unlockPolicy={unlockPolicy}
              draftDiffPolicy={draftDiffPolicy}
              onShareVisibilityChange={(visibility) => {
                void setShareVisibility(visibility);
              }}
              onSyncTargetProviderChange={(provider) => {
                void setSyncTargetProvider(provider);
              }}
              onUnlockPolicyChange={(policy) => {
                void setUnlockPolicy(policy);
              }}
              onDraftDiffPolicyChange={(policy) => {
                void setDraftDiffPolicy(policy);
              }}
            />

            <Separator className="bg-border" />

            <EmbedsSection
              allowedUrls={allowedUrls}
              onAllowedUrlsChange={(urls) => {
                void setAllowedUrls(urls);
              }}
            />

            <Separator className="bg-border" />

            <ShortcutsSection />

            <Separator className="bg-border" />

            <StorageSection
              offlineMode={offlineMode}
              onOfflineModeChange={(enabled) => {
                void setOfflineMode(enabled);
              }}
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default SettingsModal;

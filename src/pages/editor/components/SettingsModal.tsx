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
  DEFAULT_NETWORK_ALLOWLIST,
  normalizeNetworkAllowlist,
  parseNetworkAllowlistInput,
} from "../../../lib/networkAllowlist";
interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

type ThemeOption = {
  id: string;
  name: string;
};

type ShareVisibility = "private" | "unlisted" | "public";
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
  draftDiffPolicy: DraftDiffPolicy;
  passkeyProtectionEnabled: boolean;
  onShareVisibilityChange: (visibility: ShareVisibility) => void;
  onDraftDiffPolicyChange: (policy: DraftDiffPolicy) => void;
  onPasskeyProtectionChange: (enabled: boolean) => void;
}

const AccessSection: React.FC<AccessSectionProps> = ({
  offlineMode,
  shareVisibility,
  draftDiffPolicy,
  passkeyProtectionEnabled,
  onShareVisibilityChange,
  onDraftDiffPolicyChange,
  onPasskeyProtectionChange,
}) => (
  <SettingsSection title="Access">
    <div className="space-y-2">
      <Label htmlFor="link-visibility-select" className={FIELD_LABEL_CLASS}>
        Link privacy (online mode)
      </Label>
      <Select
        value={shareVisibility}
        onValueChange={(value) => {
          if (value === "private" || value === "unlisted" || value === "public") {
            onShareVisibilityChange(value);
          }
        }}
      >
        <SelectTrigger id="link-visibility-select" className="w-full justify-between">
          <SelectValue placeholder="Select link privacy" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="private">Private (account-only)</SelectItem>
          <SelectItem value="unlisted">Unlisted (link-only)</SelectItem>
          <SelectItem value="public">Public</SelectItem>
        </SelectContent>
      </Select>
      <p className="text-xs text-muted">
        {shareVisibility === "private"
          ? "Private links stay account-locked even online."
          : "Unlisted and public links are shareable online with recovery unlock support."}
      </p>
      {offlineMode ? (
        <p className="text-xs text-muted">
          You are currently offline. This setting applies the next time you publish online.
        </p>
      ) : null}
    </div>

    <div className="rounded-md border border-border bg-background px-3 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="text-sm font-medium text-foreground">Passkey protection</div>
          <div className="text-xs text-muted">
            {passkeyProtectionEnabled
              ? "Require passkey verification before unwrapping local vault keys."
              : "Skip passkey prompts and unlock with local vault keys directly on this device."}
          </div>
        </div>

        <Switch
          checked={passkeyProtectionEnabled}
          onCheckedChange={onPasskeyProtectionChange}
          aria-label="Toggle passkey protection"
        />
      </div>
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
  </SettingsSection>
);

interface NetworkSectionProps {
  allowedUrls: readonly string[];
  onAllowedUrlsChange: (urls: readonly string[]) => void;
}

const NetworkSection: React.FC<NetworkSectionProps> = ({
  allowedUrls,
  onAllowedUrlsChange,
}) => {
  const [draftValue, setDraftValue] = useState(allowedUrls.join("\n"));

  useEffect(() => {
    setDraftValue(allowedUrls.join("\n"));
  }, [allowedUrls]);

  const parsedAllowlist = useMemo(
    () => parseNetworkAllowlistInput(draftValue),
    [draftValue],
  );

  const activeAllowlist = useMemo(
    () => normalizeNetworkAllowlist(allowedUrls),
    [allowedUrls],
  );

  const hasChanges =
    parsedAllowlist.join("\n") !== activeAllowlist.join("\n");

  return (
    <SettingsSection title="Network">
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
          placeholder={DEFAULT_NETWORK_ALLOWLIST.join("\n")}
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
              const defaults = [...DEFAULT_NETWORK_ALLOWLIST];
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
}
const StorageSection: React.FC<StorageSectionProps> = ({ offlineMode }) => (
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
              : "Drops are encrypted and published online. Private links stay account-only; shared links can be recovered online."}
          </div>
        </div>

        <div className="rounded-md border border-border px-2 py-1 text-xs text-muted">
          Switch from the top bar
        </div>
      </div>

      <div className="mt-3 text-xs text-muted">
        Current mode: {offlineMode ? "Offline" : "Online"}
      </div>

      <div className="mt-1 text-xs text-muted">
        {offlineMode
          ? "Offline links are local-only and work in this browser profile."
          : "Online links work across devices when shared, and private links remain account-locked."}
      </div>
    </div>
  </SettingsSection>
);

const SettingsModal: React.FC<SettingsModalProps> = ({ open, onClose }) => {
  const { themeId, setThemeId, typefaceId, setTypefaceId } = useTheme();
  const catalog = useThemeCatalog();
  const typefaces = useTypefaceCatalog();
  const offlineMode = useDropStore((state) => state.offlineMode);
  const shareVisibility = useDropStore((state) => state.shareVisibility);
  const draftDiffPolicy = useDropStore((state) => state.draftDiffPolicy);
  const passkeyProtectionEnabled = useDropStore(
    (state) => state.passkeyProtectionEnabled,
  );
  const syntaxMode = useDropStore((state) => state.syntaxMode);
  const allowedUrls = useDropStore((state) => state.allowedUrls);
  const setShareVisibility = useDropStore((state) => state.setShareVisibility);
  const setDraftDiffPolicy = useDropStore((state) => state.setDraftDiffPolicy);
  const setPasskeyProtectionEnabled = useDropStore(
    (state) => state.setPasskeyProtectionEnabled,
  );
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
              draftDiffPolicy={draftDiffPolicy}
              passkeyProtectionEnabled={passkeyProtectionEnabled}
              onShareVisibilityChange={(visibility) => {
                void setShareVisibility(visibility);
              }}
              onDraftDiffPolicyChange={(policy) => {
                void setDraftDiffPolicy(policy);
              }}
              onPasskeyProtectionChange={(enabled) => {
                void setPasskeyProtectionEnabled(enabled);
              }}
            />

            <Separator className="bg-border" />

            <NetworkSection
              allowedUrls={allowedUrls}
              onAllowedUrlsChange={(urls) => {
                void setAllowedUrls(urls);
              }}
            />

            <Separator className="bg-border" />

            <ShortcutsSection />

            <Separator className="bg-border" />

            <StorageSection offlineMode={offlineMode} />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default SettingsModal;

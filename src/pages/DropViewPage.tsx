import React, { useState, useEffect } from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import { useParams, Link, type LinkProps } from "react-router-dom";
import { Button } from "@/components/ui/button";
import EnhancedMarkdown from "../components/EnhancedMarkdown";
import { useTheme } from "../theme/themeContext";
import useDropStore from "../stores/dropStore";
import { getMarkdownTitle } from "../lib/markdownText";
import {
  RenderCancelledError,
  renderMarkdownWithNullplug,
} from "../lib/nullplug";
import { toUserFacingDropError } from "../lib/drop/userErrors";
import {
  DEFAULT_IFRAME_ALLOWLIST,
  resolveIframeAllowlist,
} from "../lib/iframeAllowlist";
import { toShortDropId } from "../../shared/drop/id";
import { upsertRecentExternalDrop } from "../lib/drop/recentExternalDrops";

function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = title;
  }, [title]);
}

const formatDropLoadError = (error: unknown): string => {
  return toUserFacingDropError(
    error,
    "An error occurred while fetching the drop.",
  );
};

const DropViewPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const [dropContent, setDropContent] = useState<string | null>(null);
  const [renderedContent, setRenderedContent] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sourceAllowedUrls, setSourceAllowedUrls] = useState<string[]>([
    ...DEFAULT_IFRAME_ALLOWLIST,
  ]);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">(
    "idle",
  );
  const [isExpanded, setIsExpanded] = useState(false);
  const [editHref, setEditHref] = useState<string>("/");
  const { setThemeId } = useTheme();
  const getDrop = useDropStore((state) => state.getDrop);
  const resolveDropOwnership = useDropStore(
    (state) => state.resolveDropOwnership,
  );
  const LinkComponent = Link as unknown as React.FC<LinkProps>;

  const handleCopyContent = async () => {
    if (!dropContent) {
      return;
    }

    if (!navigator?.clipboard?.writeText) {
      setCopyState("error");
      window.setTimeout(() => setCopyState("idle"), 2000);
      return;
    }

    try {
      await navigator.clipboard.writeText(dropContent);
      setCopyState("copied");
    } catch (err) {
      console.error("Failed to copy drop content:", err);
      setCopyState("error");
    }

    window.setTimeout(() => setCopyState("idle"), 2000);
  };

  useEffect(() => {
    if (!id) {
      setError("No drop ID provided.");
      setIsLoading(false);
      return;
    }

    const fetchDrop = async () => {
      setIsLoading(true);
      setError(null);

      try {
        let resolvedDropId = id;
        let ownedByCurrentAccount = false;

        try {
          const ownership = await resolveDropOwnership(id);
          if (ownership) {
            resolvedDropId = ownership.id;
            ownedByCurrentAccount = ownership.ownedByCurrentAccount;
          }
        } catch (ownershipError) {
          console.error("Failed to resolve drop ownership:", ownershipError);
        }

        setEditHref(
          `/?${ownedByCurrentAccount ? "edit" : "clone"}=${encodeURIComponent(
            resolvedDropId,
          )}`,
        );

        const payload = await getDrop(id);
        if (!payload) {
          setError("We couldn't find that drop.");
          setDropContent(null);
          setSourceAllowedUrls([...DEFAULT_IFRAME_ALLOWLIST]);
          return;
        }

        setDropContent(payload.content);
        setRenderedContent(payload.content);
        setSourceAllowedUrls(resolveIframeAllowlist(payload.metadata?.allowedUrls));
        void setThemeId(payload.metadata?.themeId ?? "system");

        if (!ownedByCurrentAccount) {
          upsertRecentExternalDrop({
            id: resolvedDropId,
            title:
              getMarkdownTitle(payload.content) ||
              `Nulldown ${toShortDropId(resolvedDropId)}`,
            preview: payload.content,
          });
        }
      } catch (err: unknown) {
        console.error(`Failed to fetch drop "${id}":`, err);
        setError(formatDropLoadError(err));
        setDropContent(null);
        setSourceAllowedUrls([...DEFAULT_IFRAME_ALLOWLIST]);
      } finally {
        setIsLoading(false);
      }
    };

    fetchDrop();
  }, [getDrop, id, resolveDropOwnership, setThemeId]);

  useEffect(() => {
    if (!dropContent) {
      setRenderedContent(null);
      return;
    }

    let active = true;

    const renderContent = async () => {
      try {
        const rendered = await renderMarkdownWithNullplug(dropContent, {
          allowedUrls: sourceAllowedUrls,
          onFlush: (buffered) => {
            if (active) {
              setRenderedContent(buffered);
            }
          },
          shouldCancel: () => !active,
        });

        if (active) {
          setRenderedContent(rendered);
        }
      } catch (renderError) {
        if (renderError instanceof RenderCancelledError) {
          return;
        }

        if (active) {
          console.error("Failed to render drop content:", renderError);
          setRenderedContent(dropContent);
        }
      }
    };

    void renderContent();

    return () => {
      active = false;
    };
  }, [dropContent, sourceAllowedUrls]);

  // Set document title based on drop content (basic version)
  const dropTitle = dropContent ? getMarkdownTitle(dropContent) : "";
  const pageTitle = isLoading
    ? "Loading Drop... | Nulldown"
    : error
      ? "Error | Nulldown"
      : dropTitle
        ? `${dropTitle} | Nulldown`
        : "Untitled Drop | Nulldown";
  useDocumentTitle(pageTitle);

  if (isLoading) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-background">
        <div className="animate-pulse text-accent font-medium">
          Loading drop...
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-background">
        <div className="text-center max-w-md">
          <p className="text-error-light mb-4">{error}</p>
          <div className="flex items-center justify-center gap-4 text-sm">
            {id && (
              <LinkComponent
                to={editHref}
                className="text-accent hover:underline"
              >
                Edit Nulldown
              </LinkComponent>
            )}
            <LinkComponent to="/" className="text-accent hover:underline">
              New Nulldown
            </LinkComponent>
          </div>
        </div>
      </div>
    );
  }

  if (!dropContent) {
    // Should be covered by error state, but as a fallback
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-background">
        <div className="text-center max-w-md">
          <p className="text-muted mb-4">Drop not found or content is empty.</p>
          <div className="flex items-center justify-center gap-4 text-sm">
            {id && (
              <LinkComponent
                to={editHref}
                className="text-accent hover:underline"
              >
                Edit Nulldown
              </LinkComponent>
            )}
            <LinkComponent to="/" className="text-accent hover:underline">
              New Nulldown
            </LinkComponent>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 flex min-h-0 flex-col bg-background">
      <div className="border-b border-border p-4 flex justify-between items-center">
        <LinkComponent to="/" className="text-sm text-accent hover:underline">
          NULLDOWN
        </LinkComponent>
        <div className="text-xs text-muted">Drop ID: {id}</div>
      </div>

      <div
        className={
          isExpanded ? "flex-1 min-h-0 overflow-hidden p-4" : "flex-1 overflow-auto p-4"
        }
      >
        <div
          className={
            isExpanded
              ? "mx-auto flex h-full w-full flex-col gap-4"
              : "mx-auto max-w-3xl"
          }
        >
          <div
            className={
              isExpanded
                ? "group relative min-h-0 flex-1 overflow-auto rounded-md border border-border bg-card p-6"
                : "group relative rounded-md border border-border bg-card p-6"
            }
          >
            <div className="absolute right-3 top-3 z-10 flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setIsExpanded((current) => !current)}
                className="border-border bg-background/90 text-foreground shadow-sm backdrop-blur-sm hover:bg-background"
                aria-pressed={isExpanded}
                aria-label={isExpanded ? "Collapse content" : "Expand content"}
                title={isExpanded ? "Collapse content" : "Expand content"}
              >
                {isExpanded ? (
                  <Minimize2 className="h-3.5 w-3.5" aria-hidden="true" />
                ) : (
                  <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                {isExpanded ? "Collapse" : "Expand"}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleCopyContent}
                className="border-border bg-background/90 text-foreground shadow-sm backdrop-blur-sm hover:bg-background"
              >
                {copyState === "copied"
                  ? "Copied"
                  : copyState === "error"
                    ? "Copy failed"
                    : "Copy"}
              </Button>
            </div>

            <div className="pt-10">
              <EnhancedMarkdown allowedUrls={sourceAllowedUrls}>
                {renderedContent ?? dropContent}
              </EnhancedMarkdown>
            </div>
          </div>

          <div className={isExpanded ? "text-center" : "mt-6 text-center"}>
            <div className="inline-flex items-center gap-4 text-sm">
              {id && (
                <LinkComponent
                  to={editHref}
                  className="text-accent hover:underline transition-colors"
                >
                  Edit Nulldown
                </LinkComponent>
              )}
              <LinkComponent
                to="/"
                className="text-accent hover:underline transition-colors"
              >
                New Nulldown
              </LinkComponent>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default DropViewPage;

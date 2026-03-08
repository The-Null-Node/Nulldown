import React, { useState, useEffect } from "react";
import { useParams, Link, type LinkProps } from "react-router-dom";
import EnhancedMarkdown from "../components/EnhancedMarkdown";
import { useTheme } from "../theme/themeContext";
import useDropStore, {
  isOfflineDropId,
} from "../stores/dropStore";
import { getMarkdownTitle } from "../lib/markdownText";

function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = title;
  }, [title]);
}

const DropViewPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const [dropContent, setDropContent] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">(
    "idle",
  );
  const { setThemeId } = useTheme();
  const getDrop = useDropStore((state) => state.getDrop);
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
        const payload = await getDrop(id);
        if (!payload) {
          setError(
            isOfflineDropId(id)
              ? "Offline drop not found on this browser profile."
              : "Drop not found.",
          );
          setDropContent(null);
          return;
        }

        setDropContent(payload.content);
        void setThemeId(payload.metadata?.themeId ?? "system");
      } catch (err: any) {
        console.error("Failed to fetch drop:", err);
        setError(err.message || "An error occurred while fetching the drop.");
        setDropContent(null);
      } finally {
        setIsLoading(false);
      }
    };

    fetchDrop();
  }, [getDrop, id, setThemeId]);

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
                to={`/?clone=${id}`}
                className="text-accent hover:underline"
              >
                Clone Nulldown
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
                to={`/?clone=${id}`}
                className="text-accent hover:underline"
              >
                Clone Nulldown
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
    <div className="fixed inset-0 flex flex-col bg-background">
      <div className="border-b border-border p-4 flex justify-between items-center">
        <LinkComponent to="/" className="text-sm text-accent hover:underline">
          NULLDOWN
        </LinkComponent>
        <div className="text-xs text-muted">Drop ID: {id}</div>
      </div>

      <div className="flex-1 overflow-auto p-4">
        <div className="group relative max-w-3xl mx-auto bg-card border border-border rounded-md p-6">
          <button
            type="button"
            onClick={handleCopyContent}
            className="absolute right-3 top-3 rounded-md border border-border bg-background/90 px-2.5 py-1 text-xs text-foreground opacity-0 transition-opacity hover:bg-background focus:opacity-100 focus-visible:opacity-100 group-hover:opacity-100"
          >
            {copyState === "copied"
              ? "Copied"
              : copyState === "error"
                ? "Copy failed"
                : "Copy"}
          </button>
          <EnhancedMarkdown>{dropContent}</EnhancedMarkdown>
        </div>

        <div className="mt-6 text-center">
          <div className="inline-flex items-center gap-4 text-sm">
            {id && (
              <LinkComponent
                to={`/?clone=${id}`}
                className="text-accent hover:underline transition-colors"
              >
                Clone Nulldown
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
  );
};

export default DropViewPage;

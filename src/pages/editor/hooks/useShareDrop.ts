import { useCallback, useState } from "react";

interface ShareApiResponse {
  id?: string;
  url?: string;
  error?: string;
}

export function useShareDrop(markdown: string, clearDraft: () => void) {
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successUrl, setSuccessUrl] = useState<string | null>(null);

  const resetShare = useCallback(() => {
    setSuccessUrl(null);
    setError(null);
  }, []);

  const shareDrop = useCallback(async () => {
    if (!markdown.trim()) {
      setError("Cannot share empty content.");
      return;
    }

    setSharing(true);
    setError(null);
    setSuccessUrl(null);

    try {
      const response = await fetch("/api/store", {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
        },
        body: markdown,
      });

      if (!response.ok) {
        const errorData = await response.text();
        throw new Error(
          errorData || `Failed to create drop: ${response.statusText}`,
        );
      }

      const result: ShareApiResponse = await response.json();
      if (result.id && result.url) {
        setSuccessUrl(result.url);
        clearDraft();
      } else {
        setError(
          result.error || "Failed to create drop. Unknown error from API.",
        );
      }
    } catch (err: any) {
      console.error("Share error:", err);
      setError(err.message || "An unexpected error occurred while sharing.");
    } finally {
      setSharing(false);
    }
  }, [clearDraft, markdown]);

  return {
    error,
    resetShare,
    setError,
    shareDrop,
    sharing,
    successUrl,
  };
}

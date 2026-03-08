import React, { useCallback } from "react";

interface ShareSuccessViewProps {
  successUrl: string;
  onCopyError: (message: string) => void;
  onNewDrop: () => void;
  offline?: boolean;
}

const ShareSuccessView: React.FC<ShareSuccessViewProps> = ({
  successUrl,
  onCopyError,
  onNewDrop,
  offline = false,
}) => {
  const handleCopy = useCallback(() => {
    if (!navigator?.clipboard?.writeText) {
      onCopyError("Clipboard is unavailable.");
      return;
    }

    navigator.clipboard.writeText(successUrl).catch((err) => {
      console.error("Failed to copy:", err);
      onCopyError("Failed to copy link.");
    });
  }, [onCopyError, successUrl]);

  return (
    <main className="flex-1 p-4 flex items-center justify-center">
      <div className="max-w-md w-full bg-card border border-border rounded-md p-6">
        <h2 className="text-xl mb-4 text-accent">
          {offline ? "Drop Saved Offline" : "Drop Created"}
        </h2>
        <p className="mb-4 text-sm">
          {offline
            ? "Your drop was saved in your browser."
            : "Your markdown has been dropped into the void."}
        </p>
        {offline ? (
          <p className="mb-4 text-xs text-muted">
            This link works only in this browser.
          </p>
        ) : null}
        <div className="flex mb-4">
          <input
            type="text"
            value={successUrl}
            readOnly
            className="flex-1 bg-background border border-border border-r-0 rounded-l-md p-2 text-sm text-foreground focus:outline-none"
          />
          <button
            onClick={handleCopy}
            className="bg-accent text-accent-foreground hover:bg-accent-hover rounded-r-md px-4 py-2 text-sm font-medium transition-colors"
          >
            Copy
          </button>
        </div>
        <div className="flex justify-between">
          <button
            onClick={onNewDrop}
            className="border border-accent text-accent hover:bg-accent/10 rounded-md px-4 py-2 text-sm font-medium transition-colors"
          >
            New Drop
          </button>
          <a
            href={successUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="bg-accent text-accent-foreground hover:bg-accent-hover rounded-md px-4 py-2 text-sm font-medium transition-colors inline-block"
          >
            {offline ? "Open Offline Drop" : "Visit Drop"}
          </a>
        </div>
      </div>
    </main>
  );
};

export default ShareSuccessView;

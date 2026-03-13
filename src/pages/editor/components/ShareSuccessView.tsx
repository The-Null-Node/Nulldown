import React, { useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

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
      <Card className="max-w-md w-full border-border bg-card">
        <CardHeader className="pb-2">
          <CardTitle className="text-xl text-accent">
            {offline ? "Drop Saved Offline" : "Drop Created"}
          </CardTitle>
        </CardHeader>

        <CardContent>
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

          <div className="mb-4 flex items-center gap-2">
            <Input value={successUrl} readOnly className="bg-background border-border" />
            <Button
              onClick={handleCopy}
              className="bg-accent text-accent-foreground hover:bg-accent-hover"
            >
              Copy
            </Button>
          </div>

          <div className="flex justify-between gap-2">
            <Button
              onClick={onNewDrop}
              variant="outline"
              className="border-accent text-accent hover:bg-accent/10"
            >
              New Drop
            </Button>

            <a
              href={successUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-8 items-center justify-center rounded-lg bg-accent px-3 text-sm font-medium text-accent-foreground hover:bg-accent-hover"
            >
              {offline ? "Open Offline Drop" : "Visit Drop"}
            </a>
          </div>
        </CardContent>
      </Card>
    </main>
  );
};

export default ShareSuccessView;

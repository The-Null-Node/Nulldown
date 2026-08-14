import React from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { DiffSyncState } from "../hooks/useDiffChannel";

interface BranchSyncBannerProps {
  state: DiffSyncState;
  onUseRemoteBranch: () => void;
}

const BranchSyncBanner: React.FC<BranchSyncBannerProps> = ({
  state,
  onUseRemoteBranch,
}) => {
  if (state.mode !== "blocked" || !state.message) return null;

  return (
    <div className="absolute top-2 left-4 right-4 z-10">
      <Alert variant="destructive" className="border-error/60 bg-error/20 text-error-light">
        <AlertTitle>Sync conflict</AlertTitle>
        <AlertDescription className="text-error-light">
          {state.message} Your local text is still on this device and has not been overwritten.
        </AlertDescription>
        <div className="mt-3">
          <Button type="button" size="sm" variant="outline" onClick={onUseRemoteBranch}>
            Use remote branch
          </Button>
        </div>
      </Alert>
    </div>
  );
};

export default BranchSyncBanner;

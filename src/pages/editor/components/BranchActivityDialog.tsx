import React, { useCallback, useEffect, useRef, useState } from "react";
import { GitBranch, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type {
  DropBranchContentResponse,
  DropBranchRecord,
} from "../../../../shared/drop/branch";
import { createBranchApiClient } from "../../../../shared/drop/branchApi";
import {
  getBranchWriterLabel,
  groupBranchActivity,
  summarizeBranchTextComparison,
} from "../../../lib/branchActivity";

interface BranchActivityDialogProps {
  open: boolean;
  rootDropId: string;
  activeBranchId: string;
  activeContent: string;
  accountId: string;
  clientId: string;
  authTokenProvider: () => Promise<string | null>;
  onOpenChange: (open: boolean) => void;
}

const formatTimestamp = (timestamp: number): string => {
  try {
    return new Date(timestamp).toLocaleString();
  } catch {
    return "Unknown";
  }
};

const BranchMetadata: React.FC<{ branch: DropBranchRecord }> = ({ branch }) => (
  <div className="mt-2 grid gap-1 text-xs text-muted sm:grid-cols-2">
    <span>Root owner: {branch.ownerAccountId ?? "Unknown"}</span>
    <span>Branch writer: {getBranchWriterLabel(branch)}</span>
    <span>Snapshot: {branch.headSnapshotId}</span>
    <span>Event cursor: {branch.headEventSeq ?? "None"}</span>
    <span className="sm:col-span-2">Updated: {formatTimestamp(branch.updatedAt)}</span>
  </div>
);

const BranchActivityDialog: React.FC<BranchActivityDialogProps> = ({
  open,
  rootDropId,
  activeBranchId,
  activeContent,
  accountId,
  clientId,
  authTokenProvider,
  onOpenChange,
}) => {
  const [branches, setBranches] = useState<DropBranchRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedContent, setSelectedContent] =
    useState<DropBranchContentResponse | null>(null);
  const [selectedBranchId, setSelectedBranchId] = useState<string | null>(null);
  const branchRequestRef = useRef(0);
  const contentRequestRef = useRef(0);

  const createClient = useCallback(
    () =>
      createBranchApiClient({
        baseUrl: "",
        accountId,
        clientId,
        authTokenProvider,
      }),
    [accountId, authTokenProvider, clientId],
  );

  const refresh = useCallback(async () => {
    const requestId = ++branchRequestRef.current;
    setLoading(true);
    setError(null);
    contentRequestRef.current += 1;
    setSelectedContent(null);
    setSelectedBranchId(null);
    try {
      const response = await createClient().listBranches(rootDropId);
      if (requestId !== branchRequestRef.current) return;
      setBranches(response.branches);
    } catch (refreshError) {
      if (requestId !== branchRequestRef.current) return;
      setBranches([]);
      setError(
        refreshError instanceof Error
          ? refreshError.message
          : "Unable to load branches.",
      );
    } finally {
      if (requestId === branchRequestRef.current) {
        setLoading(false);
      }
    }
  }, [createClient, rootDropId]);

  useEffect(() => {
    if (!open) {
      branchRequestRef.current += 1;
      contentRequestRef.current += 1;
      setLoading(false);
      setSelectedContent(null);
      setSelectedBranchId(null);
      return;
    }

    void refresh();
  }, [open, refresh]);

  const openReadOnlyPreview = async (branch: DropBranchRecord) => {
    if (branch.branchId === activeBranchId) return;

    const requestId = ++contentRequestRef.current;
    setSelectedBranchId(branch.branchId);
    setSelectedContent(null);
    setError(null);
    try {
      const content = await createClient().getBranchContent(
        rootDropId,
        branch.branchId,
      );
      if (requestId !== contentRequestRef.current) return;
      setSelectedContent(content);
    } catch (contentError) {
      if (requestId !== contentRequestRef.current) return;
      setError(
        contentError instanceof Error
          ? contentError.message
          : "Unable to load branch content.",
      );
    } finally {
      if (requestId === contentRequestRef.current) {
        setSelectedBranchId(null);
      }
    }
  };

  const groups = groupBranchActivity(branches, activeBranchId);
  const comparison = selectedContent
    ? summarizeBranchTextComparison(activeContent, selectedContent.content)
    : null;
  const renderGroup = (label: string, entries: readonly DropBranchRecord[]) => (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">
        {label}
      </h3>
      {entries.map((branch) => {
        const isActive = branch.branchId === activeBranchId;
        const isLoadingContent = selectedBranchId === branch.branchId;
        return (
          <div
            key={branch.branchId}
            className="rounded-md border border-border bg-background px-3 py-2"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-foreground">
                  {isActive ? "Current branch" : branch.branchId}
                </div>
                <div className="text-xs text-muted">
                  {isActive
                    ? branch.branchId
                    : branch.mode === "owner"
                      ? "Owner branch"
                      : "Actor branch"}
                </div>
              </div>
              {isActive ? (
                <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted uppercase">
                  Writing
                </span>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={isLoadingContent}
                  onClick={() => {
                    void openReadOnlyPreview(branch);
                  }}
                >
                  {isLoadingContent ? "Loading..." : "Compare"}
                </Button>
              )}
            </div>
            <BranchMetadata branch={branch} />
          </div>
        );
      })}
    </section>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] w-[min(52rem,calc(100vw-1.5rem))] max-w-none flex-col overflow-hidden rounded-xl border border-border bg-card p-0 text-foreground">
        <DialogHeader className="shrink-0 border-b border-border px-4 py-4">
          <div className="flex items-center justify-between gap-3 pr-8">
            <div>
              <DialogTitle className="text-base">Branch activity</DialogTitle>
              <DialogDescription className="mt-1">
                Compare the current editor buffer with a read-only branch head.
              </DialogDescription>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={loading}
              onClick={() => {
                void refresh();
              }}
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              Refresh
            </Button>
          </div>
        </DialogHeader>

        <div className="grid flex-1 gap-4 overflow-y-auto p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="space-y-5">
            {loading ? (
              <div className="rounded-md border border-border bg-background px-3 py-6 text-center text-sm text-muted">
                Loading branches...
              </div>
            ) : (
              <>
                {renderGroup("Mine", groups.mine)}
                {groups.main.length ? (
                  renderGroup("Main", groups.main)
                ) : (
                  <section className="space-y-2">
                    <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">
                      Main
                    </h3>
                    <div className="rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted">
                      Main not initialized.
                    </div>
                  </section>
                )}
                {groups.other.length ? renderGroup("Other", groups.other) : null}
              </>
            )}
            {error ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            ) : null}
          </div>

          <section className="min-h-48 rounded-md border border-border bg-background p-3">
            <div className="mb-2 flex items-center gap-2 text-sm font-medium">
              <GitBranch className="h-4 w-4 text-muted" aria-hidden="true" />
              Read-only comparison
            </div>
            {selectedContent ? (
              <>
                <div className="mb-3 rounded-md border border-border bg-muted/30 px-2 py-1.5 text-xs text-muted">
                  {comparison?.operations === 0
                    ? "No text changes."
                    : `${comparison?.operations} operations: ${comparison?.additions} additions, ${comparison?.removals} removals.`}
                </div>
                <div className="grid gap-3 xl:grid-cols-2">
                  <div>
                    <div className="mb-1 text-xs text-muted">
                      Current editor buffer
                    </div>
                    <pre className="max-h-[42dvh] overflow-auto whitespace-pre-wrap break-words rounded border border-border p-2 font-mono text-xs text-foreground">
                      {activeContent}
                    </pre>
                  </div>
                  <div>
                    <div className="mb-1 text-xs text-muted">
                      {selectedContent.branchId} at snapshot {selectedContent.snapshotId}
                    </div>
                    <pre className="max-h-[42dvh] overflow-auto whitespace-pre-wrap break-words rounded border border-border p-2 font-mono text-xs text-foreground">
                      {selectedContent.content}
                    </pre>
                  </div>
                </div>
              </>
            ) : (
              <p className="text-sm text-muted">
                Choose another branch to compare its head with this editor without changing either branch.
              </p>
            )}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default BranchActivityDialog;

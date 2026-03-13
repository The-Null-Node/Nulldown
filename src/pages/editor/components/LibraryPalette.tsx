import React, { useEffect, useMemo, useState } from "react";
import { Link2, PencilLine, RefreshCw, Search } from "lucide-react";
import { toShortDropId } from "../../../../shared/drop/id";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { DraftLibraryEntry } from "../../../lib/draft/library";
import type { OwnedDropRecord } from "../../../stores/dropStore";

interface LibraryPaletteProps {
  open: boolean;
  loading: boolean;
  drops: OwnedDropRecord[];
  drafts: DraftLibraryEntry[];
  onOpenChange: (open: boolean) => void;
  onOpenDrop: (id: string) => void;
  onEditDrop: (id: string) => void;
  onOpenDraft: (entry: DraftLibraryEntry) => void;
  onNewDrop: () => void;
  onRefresh: () => void;
}

const formatTimestamp = (timestamp: number) => {
  try {
    return new Date(timestamp).toLocaleString();
  } catch {
    return "Unknown";
  }
};

const normalizeForSearch = (value: string) => value.toLowerCase();

const LibraryPalette: React.FC<LibraryPaletteProps> = ({
  open,
  loading,
  drops,
  drafts,
  onOpenChange,
  onOpenDrop,
  onEditDrop,
  onOpenDraft,
  onNewDrop,
  onRefresh,
}) => {
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) {
      setQuery("");
    }
  }, [open]);

  const normalizedQuery = normalizeForSearch(query.trim());

  const filteredDrafts = useMemo(() => {
    if (!normalizedQuery) {
      return drafts;
    }

    return drafts.filter((entry) => {
      const searchable = normalizeForSearch(
        `${entry.title} ${entry.preview} ${entry.dropId ?? ""} ${entry.draftId}`,
      );
      return searchable.includes(normalizedQuery);
    });
  }, [drafts, normalizedQuery]);

  const filteredDrops = useMemo(() => {
    if (!normalizedQuery) {
      return drops;
    }

    return drops.filter((entry) => {
      const searchable = normalizeForSearch(
        `${entry.id} ${toShortDropId(entry.id)} ${entry.visibility}`,
      );
      return searchable.includes(normalizedQuery);
    });
  }, [drops, normalizedQuery]);

  const isEmpty = !filteredDrafts.length && !filteredDrops.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="w-[min(44rem,calc(100vw-1.5rem))] max-w-none gap-3 rounded-xl border border-border bg-card p-0"
      >
        <DialogHeader className="border-b border-border px-4 pt-4 pb-3">
          <div className="flex items-center justify-between gap-2">
            <DialogTitle className="text-base">Library</DialogTitle>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={onRefresh}
                disabled={loading}
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Refresh
              </Button>
              <Button type="button" size="sm" onClick={onNewDrop}>
                New Nulldown
              </Button>
            </div>
          </div>
          <div className="relative mt-3">
            <Search className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-muted" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="pl-8"
              placeholder="Search drops and drafts"
            />
          </div>
        </DialogHeader>

        <div className="max-h-[min(62vh,38rem)] overflow-y-auto px-4 pb-4">
          {loading ? (
            <div className="rounded-md border border-border bg-background px-3 py-6 text-center text-sm text-muted">
              Loading library...
            </div>
          ) : isEmpty ? (
            <div className="rounded-md border border-border bg-background px-3 py-6 text-center text-sm text-muted">
              No matches yet.
            </div>
          ) : (
            <div className="space-y-5">
              {filteredDrafts.length > 0 ? (
                <section className="space-y-2">
                  <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">
                    Drafts ({filteredDrafts.length})
                  </h3>
                  <div className="space-y-2">
                    {filteredDrafts.map((entry) => (
                      <div
                        key={entry.draftKey}
                        className="rounded-md border border-border bg-background px-3 py-2"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium text-foreground">
                              {entry.title}
                            </div>
                            <div className="mt-0.5 truncate text-xs text-muted">
                              {entry.preview}
                            </div>
                          </div>
                          <Button
                            type="button"
                            size="sm"
                            onClick={() => onOpenDraft(entry)}
                          >
                            <PencilLine className="h-3.5 w-3.5" />
                            Resume
                          </Button>
                        </div>
                        <div className="mt-1 text-[11px] text-muted">
                          {entry.dropId
                            ? `From drop ${toShortDropId(entry.dropId)} • `
                            : "Scratch draft • "}
                          Updated {formatTimestamp(entry.updatedAt)}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}

              {filteredDrops.length > 0 ? (
                <section className="space-y-2">
                  <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">
                    Drops ({filteredDrops.length})
                  </h3>
                  <div className="space-y-2">
                    {filteredDrops.map((entry) => (
                      <div
                        key={entry.id}
                        className="rounded-md border border-border bg-background px-3 py-2"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium text-foreground">
                              {toShortDropId(entry.id)}
                              <span className="ml-2 text-xs text-muted">{entry.visibility}</span>
                            </div>
                            <div className="truncate text-xs text-muted">
                              Updated {formatTimestamp(entry.updatedAt)}
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => onOpenDrop(entry.id)}
                            >
                              <Link2 className="h-3.5 w-3.5" />
                              Open
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              onClick={() => onEditDrop(entry.id)}
                            >
                              <PencilLine className="h-3.5 w-3.5" />
                              Edit
                            </Button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default LibraryPalette;

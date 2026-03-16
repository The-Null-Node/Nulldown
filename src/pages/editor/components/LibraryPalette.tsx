import React, { useEffect, useMemo, useState } from "react";
import { RefreshCw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  matchesSearchable,
  type Searchable,
  type SearchableGroup,
} from "../../../lib/search/searchable";

interface LibraryPaletteProps<T = unknown> {
  open: boolean;
  loading: boolean;
  groups: readonly SearchableGroup<T>[];
  onOpenChange: (open: boolean) => void;
  onSelectEntity: (entity: Searchable<T>) => void;
  onRefresh: () => void;
}

const LibraryPalette = <T,>({
  open,
  loading,
  groups,
  onOpenChange,
  onSelectEntity,
  onRefresh,
}: LibraryPaletteProps<T>) => {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setActiveIndex(0);
    }
  }, [open]);

  const filteredGroups = useMemo(() => {
    return groups
      .map((group) => ({
        ...group,
        entities: group.entities.filter((entity) => matchesSearchable(entity, query)),
      }))
      .filter((group) => group.entities.length > 0);
  }, [groups, query]);

  const flattened = useMemo(
    () => filteredGroups.flatMap((group) => group.entities),
    [filteredGroups],
  );

  useEffect(() => {
    if (!flattened.length) {
      setActiveIndex(0);
      return;
    }

    setActiveIndex((current) => Math.max(0, Math.min(current, flattened.length - 1)));
  }, [flattened]);

  const isEmpty = flattened.length === 0;

  const onSelect = (entity: Searchable<T>) => {
    onSelectEntity(entity);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="w-[min(44rem,calc(100vw-1.5rem))] max-w-none gap-3 rounded-xl border border-border bg-card p-0"
      >
        <DialogHeader className="border-b border-border px-4 pt-4 pb-3">
          <div className="flex items-center justify-between gap-2">
            <DialogTitle className="text-base">Search</DialogTitle>
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
            </div>
          </div>
          <div className="relative mt-3">
            <Search className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-muted" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (!flattened.length) {
                  return;
                }

                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setActiveIndex((current) =>
                    Math.min(current + 1, flattened.length - 1),
                  );
                  return;
                }

                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setActiveIndex((current) => Math.max(current - 1, 0));
                  return;
                }

                if (event.key === "Enter") {
                  event.preventDefault();
                  const active = flattened[activeIndex];
                  if (active) {
                    onSelect(active);
                  }
                }
              }}
              className="pl-8"
              placeholder="Search drafts, drops, blocks, commands"
              autoFocus
            />
          </div>
        </DialogHeader>

        <div className="max-h-[min(62vh,38rem)] overflow-y-auto px-4 pb-4">
          {loading ? (
            <div className="rounded-md border border-border bg-background px-3 py-6 text-center text-sm text-muted">
              Loading search index...
            </div>
          ) : isEmpty ? (
            <div className="rounded-md border border-border bg-background px-3 py-6 text-center text-sm text-muted">
              No matches yet.
            </div>
          ) : (
            <div className="space-y-5">
              {filteredGroups.map((group) => (
                <section key={group.id} className="space-y-2">
                  <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">
                    {group.label} ({group.entities.length})
                  </h3>
                  <div className="space-y-2">
                    {group.entities.map((entity) => {
                      const index = flattened.findIndex((entry) => entry.id === entity.id);
                      const isActive = index === activeIndex;

                      return (
                        <button
                          key={entity.id}
                          type="button"
                          onMouseEnter={() => {
                            if (index >= 0) {
                              setActiveIndex(index);
                            }
                          }}
                          onClick={() => onSelect(entity)}
                          className={`w-full rounded-md border px-3 py-2 text-left transition-colors ${
                            isActive
                              ? "border-accent bg-accent/10"
                              : "border-border bg-background hover:bg-background/70"
                          }`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="truncate text-sm font-medium text-foreground">
                                {entity.title}
                              </div>
                              {entity.description ? (
                                <div className="mt-0.5 truncate text-xs text-muted">
                                  {entity.description}
                                </div>
                              ) : null}
                            </div>
                            <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted uppercase">
                              {entity.type}
                            </span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default LibraryPalette;

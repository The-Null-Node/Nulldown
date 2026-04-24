import { useCallback, useEffect, useRef, useState } from "react";
import useDropStore from "../../stores/dropStore";
import {
  getOfflineSearchIndex,
  searchableToOfflineDocument,
  type OfflineSearchResult,
} from "./offlineSearch";
import type { Searchable, SearchableGroup } from "./searchable";

export interface UnifiedSearchResult {
  id: string;
  title: string;
  description: string;
  type: string;
  score: number;
}

export interface UseSearchIndexOptions {
  groups: SearchableGroup<unknown>[];
  autoIndex?: boolean;
}

export interface UseSearchIndexReturn {
  results: UnifiedSearchResult[];
  loading: boolean;
  refresh: () => void;
  query: string;
  setQuery: (query: string) => void;
}

export function useSearchIndex(options: UseSearchIndexOptions): UseSearchIndexReturn {
  const { groups, autoIndex = true } = options;
  const offlineMode = useDropStore((state) => state.offlineMode);
  const mode = useDropStore((state) => state.mode);
  
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<UnifiedSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const refreshTokenRef = useRef(0);

  const buildOfflineIndex = useCallback(() => {
    const index = getOfflineSearchIndex();
    index.clear();

    groups.forEach((group) => {
      group.entities.forEach((entity) => {
        index.add(searchableToOfflineDocument(entity));
      });
    });

    return index;
  }, [groups]);

  const performSearch = useCallback(async () => {
    const token = ++refreshTokenRef.current;
    setLoading(true);

    try {
      if (offlineMode) {
        // Client-side search using MiniSearch
        const index = buildOfflineIndex();
        const searchResults = index.search(query, 50);
        
        if (token !== refreshTokenRef.current) return;
        
        setResults(
          searchResults.map((result) => ({
            id: result.id,
            title: result.title,
            description: result.description,
            type: result.type,
            score: result.score,
          }))
        );
      } else {
        // Server-side search using D1
        if (!query.trim()) {
          setResults([]);
          return;
        }

        const response = await fetch(
          `/api/search?q=${encodeURIComponent(query)}&limit=50`
        );

        if (!response.ok) {
          throw new Error("Search request failed");
        }

        const data = await response.json();
        
        if (token !== refreshTokenRef.current) return;
        
        setResults(
          (data.records || []).map((record: Record<string, unknown>) => ({
            id: String(record.dropId),
            title: String(record.title || ""),
            description: String(record.contentPreview || ""),
            type: "drop",
            score: 0,
          }))
        );
      }
    } catch (error) {
      console.error("Search failed:", error);
      if (token === refreshTokenRef.current) {
        setResults([]);
      }
    } finally {
      if (token === refreshTokenRef.current) {
        setLoading(false);
      }
    }
  }, [offlineMode, query, buildOfflineIndex]);

  // Auto-index when groups change (offline mode)
  useEffect(() => {
    if (autoIndex && offlineMode) {
      buildOfflineIndex();
    }
  }, [autoIndex, offlineMode, groups, buildOfflineIndex]);

  // Search when query changes (with debounce)
  useEffect(() => {
    const timer = setTimeout(() => {
      void performSearch();
    }, 150);

    return () => clearTimeout(timer);
  }, [query, performSearch]);

  const refresh = useCallback(() => {
    void performSearch();
  }, [performSearch]);

  return {
    results,
    loading,
    refresh,
    query,
    setQuery,
  };
}

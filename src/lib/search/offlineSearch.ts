import MiniSearch from "minisearch";
import type { Searchable, SearchableGroup } from "./searchable";

export interface OfflineSearchDocument {
  id: string;
  title: string;
  description: string;
  type: string;
  keywords: string[];
  content?: string;
  updatedAt: number;
}

export interface OfflineSearchResult {
  id: string;
  title: string;
  description: string;
  type: string;
  score: number;
  match: Record<string, string[]>;
}

class OfflineSearchIndex {
  private miniSearch: MiniSearch<OfflineSearchDocument>;
  private documents: Map<string, OfflineSearchDocument> = new Map();

  constructor() {
    this.miniSearch = new MiniSearch<OfflineSearchDocument>({
      fields: ["title", "description", "content", "keywords"],
      storeFields: ["id", "title", "description", "type", "updatedAt"],
      searchOptions: {
        boost: { title: 3, description: 2, keywords: 2 },
        fuzzy: 0.2,
        prefix: true,
      },
    });
  }

  add(document: OfflineSearchDocument): void {
    this.documents.set(document.id, document);
    this.miniSearch.add(document);
  }

  remove(id: string): void {
    const doc = this.documents.get(id);
    if (doc) {
      this.miniSearch.remove(doc);
      this.documents.delete(id);
    }
  }

  update(document: OfflineSearchDocument): void {
    this.remove(document.id);
    this.add(document);
  }

  search(query: string, limit = 50): OfflineSearchResult[] {
    if (!query.trim()) {
      // Return all documents sorted by updatedAt when no query
      return Array.from(this.documents.values())
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, limit)
        .map((doc) => ({
          id: doc.id,
          title: doc.title,
          description: doc.description,
          type: doc.type,
          score: 0,
          match: {},
        }));
    }

    const results = this.miniSearch.search(query);
    return results.slice(0, limit).map((result) => ({
      id: result.id,
      title: result.title,
      description: result.description,
      type: result.type,
      score: result.score,
      match: result.match,
    }));
  }

  clear(): void {
    this.miniSearch.removeAll();
    this.documents.clear();
  }

  get size(): number {
    return this.documents.size;
  }
}

// Singleton instance
let globalIndex: OfflineSearchIndex | null = null;

export function getOfflineSearchIndex(): OfflineSearchIndex {
  if (!globalIndex) {
    globalIndex = new OfflineSearchIndex();
  }
  return globalIndex;
}

export function resetOfflineSearchIndex(): void {
  globalIndex = new OfflineSearchIndex();
}

export function searchableToOfflineDocument<T>(
  entity: Searchable<T>,
  content?: string,
  updatedAt?: number
): OfflineSearchDocument {
  return {
    id: entity.id,
    title: entity.title,
    description: entity.description || "",
    type: entity.type,
    keywords: entity.keywords ? [...entity.keywords] : [],
    content,
    updatedAt: updatedAt || Date.now(),
  };
}

export { OfflineSearchIndex };

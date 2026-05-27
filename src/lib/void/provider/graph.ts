import type {
  DropGraph,
  DropGraphNode,
  DropPayload,
} from "../../../../shared/drop/types";
import { getKvValue, isIndexedDbSupported, setKvValue } from "../../indexedDb";
import type { VoidGraph } from "./types";

export const OFFLINE_DROP_GRAPH_CACHE_PREFIX =
  "nulldown_drop_graph_cache_local_";
export const REMOTE_DROP_GRAPH_CACHE_PREFIX =
  "nulldown_drop_graph_cache_remote_";

/** Local lineage resolver used by void providers to materialize drop graphs. */
export class LineageVoidGraph implements VoidGraph {
  private readonly cachePrefix: string;

  constructor(cachePrefix: string) {
    this.cachePrefix = cachePrefix;
  }

  async resolve(
    id: string,
    getDrop: (dropId: string) => Promise<DropPayload | null>,
  ): Promise<DropGraph> {
    const cacheKey = `${this.cachePrefix}${id}`;
    const cached = await this.readCachedGraph(cacheKey);
    if (cached) {
      return cached;
    }

    const lineage: string[] = [];
    const nodes: DropGraphNode[] = [];
    const visited = new Set<string>();
    let currentId: string | null = id;

    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);

      const payload = await getDrop(currentId);
      if (!payload) {
        break;
      }

      const baseDropId =
        typeof payload.metadata?.baseDropId === "string"
          ? payload.metadata.baseDropId
          : null;

      lineage.push(currentId);
      nodes.push({
        id: currentId,
        baseDropId,
      });

      currentId = baseDropId;
    }

    if (!lineage.length) {
      throw new Error(
        "Unable to build drop graph because the head drop is missing.",
      );
    }

    const graph: DropGraph = {
      headId: id,
      rootId: lineage[lineage.length - 1],
      lineage,
      nodes,
      builtAt: Date.now(),
    };

    await this.cacheGraph(cacheKey, graph);

    return graph;
  }

  private async cacheGraph(key: string, graph: DropGraph) {
    if (!isIndexedDbSupported()) {
      return;
    }

    try {
      await setKvValue(key, graph);
    } catch (error) {
      console.error(`Failed to cache drop graph "${key}":`, error);
    }
  }

  private async readCachedGraph(key: string): Promise<DropGraph | null> {
    if (!isIndexedDbSupported()) {
      return null;
    }

    try {
      return await getKvValue<DropGraph>(key);
    } catch (error) {
      console.error(`Failed to read cached drop graph "${key}":`, error);
      return null;
    }
  }
}

import type { DropPayload } from "../../../shared/drop/types";
import type {
  NullplugCall,
  NullplugCaller,
  NullplugResult,
} from "../../../shared/nullplug/types";

export interface PluginBlock {
  id: string;
  args: string | null;
  start: number;
  end: number;
  content: string;
  info: string;
}

export interface RenderableDiff {
  start: number;
  end: number;
  text: string;
}

export interface RenderableReplacement {
  text: string;
}

export type RenderablePatch = RenderableDiff | RenderableReplacement;

export type NullplugHandlerReturn =
  | RenderablePatch
  | NullplugResult
  | string
  | null;

export interface NullplugContext {
  allowedNetworkHosts: ReadonlySet<string>;
  toTrustedEmbedUrl: (rawUrl: string) => string | null;
  caller: NullplugCaller;
  maxDepth: number;
  visitedDropIds: ReadonlySet<string>;
  resolveDrop?: (id: string) => Promise<DropPayload | null>;
}

export type NullplugHandler = (
  ctx: NullplugContext,
  blockContent: string,
  block: PluginBlock,
) => NullplugHandlerReturn | Promise<NullplugHandlerReturn>;

export type { NullplugCall, NullplugCaller, NullplugResult };

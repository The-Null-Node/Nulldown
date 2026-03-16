export interface PluginBlock {
  id: string;
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

export interface NullplugContext {
  allowedEmbedHosts: ReadonlySet<string>;
  toTrustedEmbedUrl: (rawUrl: string) => string | null;
}

export type NullplugHandler = (
  ctx: NullplugContext,
  blockContent: string,
  block: PluginBlock,
) => RenderablePatch | null | Promise<RenderablePatch | null>;

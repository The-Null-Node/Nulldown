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

export interface NullplugContext {
  allowedNetworkHosts: ReadonlySet<string>;
  toTrustedEmbedUrl: (rawUrl: string) => string | null;
}

export type NullplugHandler = (
  ctx: NullplugContext,
  blockContent: string,
  block: PluginBlock,
) => RenderablePatch | null | Promise<RenderablePatch | null>;

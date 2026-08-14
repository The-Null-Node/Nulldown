import type { RootRuntimePolicy } from "../../../shared/nullplug/policy";
import type { VoidNullplugRuntime } from "../../../shared/nullplug/runtime";
import type { NullplugInvokeRequest } from "../../../shared/nullplug/types";
import { parseNullplugArguments, parseNullplugBlocks } from "./parser";
import { resolveNullplug } from "./registry";
import type {
  NullplugCaller,
  NullplugContext,
  NullplugHandler,
  PluginBlock,
} from "./types";

export interface RenderInvocationOptions {
  caller?: NullplugCaller;
  runtimePolicy?: RootRuntimePolicy | null;
  nullplugRuntime?: VoidNullplugRuntime;
  providerId?: string;
  providerBaseUrl?: string;
  capabilities?: readonly string[];
  resolveDrop?: NullplugContext["resolveDrop"];
}

export interface RenderInvocationBlock {
  block: PluginBlock;
  sourceRange: { start: number; end: number };
  handler?: NullplugHandler;
}

export const createRenderInvokeRequest = (
  block: PluginBlock,
  options: RenderInvocationOptions,
): NullplugInvokeRequest => ({
  call: {
    pluginId: block.id,
    args: parseNullplugArguments(block.args),
    body: block.content,
    caller: options.caller ?? {},
  },
  context: {
    providerId: options.providerId ?? "nulldown-browser",
    baseUrl: options.providerBaseUrl ?? "browser://local",
    callerDropId: options.caller?.dropId,
    branchId: options.caller?.branchId,
    snapshotId: options.caller?.snapshotId,
    capabilities: [
      ...(options.capabilities ?? ["render"]),
      ...(options.resolveDrop ? ["drop.read"] : []),
    ],
  },
});

const canRemoteRuntimeOwnBareBlock = async (
  block: PluginBlock,
  options: RenderInvocationOptions,
): Promise<boolean> => {
  if (
    !options.nullplugRuntime?.supports ||
    !options.runtimePolicy?.nullplugs ||
    !Object.prototype.hasOwnProperty.call(options.runtimePolicy.nullplugs, block.id)
  ) {
    return false;
  }

  try {
    return await options.nullplugRuntime.supports(
      createRenderInvokeRequest(block, options),
    );
  } catch {
    return false;
  }
};

/** Finds local and explicitly remote-owned nullplug blocks in source order. */
export const discoverRenderInvocations = async (
  source: string,
  escapedSource: string,
  options: RenderInvocationOptions,
): Promise<RenderInvocationBlock[]> => {
  const sourceBlocks = parseNullplugBlocks(source);
  const parsedBlocks = parseNullplugBlocks(escapedSource);
  const invocations: RenderInvocationBlock[] = [];

  for (let index = 0; index < parsedBlocks.length; index += 1) {
    const block = parsedBlocks[index];
    if (!block) continue;

    const handler = resolveNullplug(block.id);
    const remoteOwned =
      block.invocationForm !== "bare" ||
      (!handler && (await canRemoteRuntimeOwnBareBlock(block, options)));
    if (!handler && !remoteOwned) continue;

    const sourceBlock = sourceBlocks[index];
    invocations.push({
      block,
      sourceRange: {
        start: sourceBlock?.start ?? block.start,
        end: sourceBlock?.end ?? block.end,
      },
      handler,
    });
  }

  return invocations;
};

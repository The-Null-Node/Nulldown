import type { NullplugHandler } from "./types";

const handlers = new Map<string, NullplugHandler>();

const normalizePluginId = (id: string) => id.trim().toLowerCase();

type NullplugHandlerWithId = NullplugHandler & {
  id?: string;
  pluginId?: string;
};

const registerNullplug = (
  id: string,
  handler: NullplugHandler,
): NullplugHandler => {
  const normalized = normalizePluginId(id);
  if (!normalized) {
    throw new Error("Plugin id must be a non-empty string.");
  }

  handlers.set(normalized, handler);
  return handler;
};

const getHandlerId = (handler: NullplugHandlerWithId): string => {
  if (typeof handler.pluginId === "string" && handler.pluginId.trim()) {
    return handler.pluginId;
  }

  if (typeof handler.id === "string" && handler.id.trim()) {
    return handler.id;
  }

  if (typeof handler.name === "string" && handler.name.trim()) {
    return handler.name;
  }

  throw new Error(
    "Plugin id must be explicit or inferred from a named handler.",
  );
};

export function nullplug(
  id: string,
): (handler: NullplugHandler) => NullplugHandler;
export function nullplug(id: string, handler: NullplugHandler): NullplugHandler;
export function nullplug(handler: NullplugHandlerWithId): NullplugHandler;
export function nullplug(
  idOrHandler: string | NullplugHandlerWithId,
  maybeHandler?: NullplugHandler,
): NullplugHandler | ((handler: NullplugHandler) => NullplugHandler) {
  if (typeof idOrHandler === "string") {
    if (maybeHandler) {
      return registerNullplug(idOrHandler, maybeHandler);
    }

    return (handler: NullplugHandler): NullplugHandler =>
      registerNullplug(idOrHandler, handler);
  }

  return registerNullplug(getHandlerId(idOrHandler), idOrHandler);
}

export const resolveNullplug = (id: string): NullplugHandler | undefined => {
  return handlers.get(normalizePluginId(id));
};

export const listNullplugIds = (): string[] => Array.from(handlers.keys());

export const clearNullplugRegistry = (): void => {
  handlers.clear();
};

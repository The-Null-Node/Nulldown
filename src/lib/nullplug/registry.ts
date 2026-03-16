import type { NullplugHandler } from "./types";

const handlers = new Map<string, NullplugHandler>();

const normalizePluginId = (id: string) => id.trim().toLowerCase();

export const nullplug = (id: string) => {
  const normalized = normalizePluginId(id);
  if (!normalized) {
    throw new Error("Plugin id must be a non-empty string.");
  }

  return (handler: NullplugHandler): NullplugHandler => {
    handlers.set(normalized, handler);
    return handler;
  };
};

export const resolveNullplug = (id: string): NullplugHandler | undefined => {
  return handlers.get(normalizePluginId(id));
};

export const listNullplugIds = (): string[] => Array.from(handlers.keys());

export const clearNullplugRegistry = (): void => {
  handlers.clear();
};

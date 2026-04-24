export type NulldownEventType =
  | "drop:created"
  | "drop:updated"
  | "drop:deleted"
  | "drop:synced"
  | "diff:received"
  | "mode:changed"
  | "draft:saved";

export interface NulldownEvent {
  type: NulldownEventType;
  payload?: Record<string, unknown>;
  timestamp: number;
}

export type NulldownEventListener = (event: NulldownEvent) => void;

class EventBus {
  private listeners = new Map<NulldownEventType, Set<NulldownEventListener>>();
  private broadcastChannel: BroadcastChannel | null = null;
  private channelName = "nulldown_events";

  constructor() {
    if (typeof BroadcastChannel !== "undefined") {
      this.broadcastChannel = new BroadcastChannel(this.channelName);
      this.broadcastChannel.onmessage = (event) => {
        const data = event.data as NulldownEvent;
        this.emitLocal(data);
      };
    }
  }

  on(type: NulldownEventType, listener: NulldownEventListener): () => void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(listener);

    return () => {
      this.listeners.get(type)?.delete(listener);
    };
  }

  once(type: NulldownEventType, listener: NulldownEventListener): () => void {
    const wrapped = (event: NulldownEvent) => {
      listener(event);
      this.off(type, wrapped);
    };
    return this.on(type, wrapped);
  }

  off(type: NulldownEventType, listener: NulldownEventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: NulldownEventType, payload?: Record<string, unknown>): void {
    const event: NulldownEvent = {
      type,
      payload,
      timestamp: Date.now(),
    };

    // Emit locally
    this.emitLocal(event);

    // Broadcast to other tabs
    this.broadcastChannel?.postMessage(event);
  }

  private emitLocal(event: NulldownEvent): void {
    const typeListeners = this.listeners.get(event.type);
    if (typeListeners) {
      typeListeners.forEach((listener) => {
        try {
          listener(event);
        } catch (error) {
          console.error(`[event-bus] Listener error for ${event.type}:`, error);
        }
      });
    }
  }

  destroy(): void {
    this.broadcastChannel?.close();
    this.broadcastChannel = null;
    this.listeners.clear();
  }
}

// Singleton instance
const globalEventBus = new EventBus();

export function getEventBus(): EventBus {
  return globalEventBus;
}

export function emitEvent(type: NulldownEventType, payload?: Record<string, unknown>): void {
  globalEventBus.emit(type, payload);
}

export function onEvent(type: NulldownEventType, listener: NulldownEventListener): () => void {
  return globalEventBus.on(type, listener);
}

import { create } from 'zustand';

/**
 * Storage operations that can be performed atomically
 */
export enum StorageOperation {
  SET = 'SET',
  REMOVE = 'REMOVE',
  CLEAR = 'CLEAR',
}


export interface IStoragePayload<T> {
  data?: string | undefined
  parse(): T
}

export interface JsonStoragePayload extends IStoragePayload<string> {
  parse(): string
}

export const createJsonStoragePayload = <T>(data: T): JsonStoragePayload => {
  let payload: string | null;

  try {
    const jsonString = JSON.stringify(data);
    payload = jsonString;
  } catch (error) {
    console.error('Failed to encode JSON:', error);
    throw new Error(`Failed to encode JSON: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }

  return {
    data: payload,
    parse: () => JSON.parse(payload)
  } as JsonStoragePayload;
}

/**
 * Result of a storage operation
 */
export interface StorageOperationResult {
  success: boolean;
  error?: string;
}


/**
 * Storage store state and actions
 */
export interface StorageState {
  // Track if we're in a browser environment
  isClient: boolean;

  // Track pending operations (for debugging/monitoring)
  pendingOperations: number;

  // Initialize the store (call once on mount)
  initialize: () => void;

  // Atomic operations
  setItem: (key: string, value: string) => StorageOperationResult;
  getItem: (key: string) => string | null;
  removeItem: (key: string) => StorageOperationResult;
  clear: () => StorageOperationResult;

  // Batch operations (atomic across multiple keys)
  batchSet: (items: Record<string, string>) => StorageOperationResult;
  batchRemove: (keys: string[]) => StorageOperationResult;
}

/**
 * Create the storage store with atomic operations
 */
const useStorageStore = create<StorageState>((set, get) => ({
  isClient: false,
  pendingOperations: 0,

  initialize: () => {
    // Check if we're in a browser environment
    const isClient = typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
    set({ isClient });
  },

  setItem: (key: string, value: string): StorageOperationResult => {
    const state = get();

    if (!state.isClient) {
      return { success: false, error: 'Not in client environment' };
    }

    try {
      set({ pendingOperations: state.pendingOperations + 1 });
      localStorage.setItem(key, value);
      set({ pendingOperations: state.pendingOperations });
      return { success: true };
    } catch (error) {
      set({ pendingOperations: state.pendingOperations });
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`Failed to set localStorage item "${key}":`, errorMessage);
      return { success: false, error: errorMessage };
    }
  },

  getItem: (key: string): string | null => {
    const state = get();

    if (!state.isClient) {
      return null;
    }

    try {
      return localStorage.getItem(key);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`Failed to get localStorage item "${key}":`, errorMessage);
      return null;
    }
  },

  removeItem: (key: string): StorageOperationResult => {
    const state = get();

    if (!state.isClient) {
      return { success: false, error: 'Not in client environment' };
    }

    try {
      set({ pendingOperations: state.pendingOperations + 1 });
      localStorage.removeItem(key);
      set({ pendingOperations: state.pendingOperations });
      return { success: true };
    } catch (error) {
      set({ pendingOperations: state.pendingOperations });
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`Failed to remove localStorage item "${key}":`, errorMessage);
      return { success: false, error: errorMessage };
    }
  },

  clear: (): StorageOperationResult => {
    const state = get();

    if (!state.isClient) {
      return { success: false, error: 'Not in client environment' };
    }

    try {
      set({ pendingOperations: state.pendingOperations + 1 });
      localStorage.clear();
      set({ pendingOperations: state.pendingOperations });
      return { success: true };
    } catch (error) {
      set({ pendingOperations: state.pendingOperations });
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Failed to clear localStorage:', errorMessage);
      return { success: false, error: errorMessage };
    }
  },

  batchSet: (items: Record<string, string>): StorageOperationResult => {
    const state = get();

    if (!state.isClient) {
      return { success: false, error: 'Not in client environment' };
    }

    try {
      set({ pendingOperations: state.pendingOperations + 1 });

      // Perform all operations atomically
      const entries = Object.entries(items);
      for (const [key, value] of entries) {
        localStorage.setItem(key, value);
      }

      set({ pendingOperations: state.pendingOperations });
      return { success: true };
    } catch (error) {
      set({ pendingOperations: state.pendingOperations });
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Failed to batch set localStorage items:', errorMessage);
      return { success: false, error: errorMessage };
    }
  },

  batchRemove: (keys: string[]): StorageOperationResult => {
    const state = get();

    if (!state.isClient) {
      return { success: false, error: 'Not in client environment' };
    }

    try {
      set({ pendingOperations: state.pendingOperations + 1 });

      // Perform all operations atomically
      for (const key of keys) {
        localStorage.removeItem(key);
      }

      set({ pendingOperations: state.pendingOperations });
      return { success: true };
    } catch (error) {
      set({ pendingOperations: state.pendingOperations });
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Failed to batch remove localStorage items:', errorMessage);
      return { success: false, error: errorMessage };
    }
  },
}));

export default useStorageStore;

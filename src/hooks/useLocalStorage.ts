import { useEffect, useCallback } from 'react';
import useStorageStore from '../stores/storageStore';

/**
 * Hook to sync a value with localStorage
 * 
 * @param key - The localStorage key
 * @param value - The current value to sync
 * @param options - Configuration options
 * @returns Object with storage operations
 */
export function useLocalStorageSync(
  key: string,
  value: string,
  options: {
    // Whether to automatically save to localStorage when value changes
    autoSave?: boolean;
    // Whether to skip saving empty values
    skipEmpty?: boolean;
  } = {}
) {
  const { autoSave = true, skipEmpty = false } = options;

  const setItem = useStorageStore(state => state.setItem);
  const removeItem = useStorageStore(state => state.removeItem);
  const isClient = useStorageStore(state => state.isClient);

  // Auto-save effect
  useEffect(() => {
    if (!autoSave || !isClient) return;

    // Skip saving empty values if configured
    if (skipEmpty && !value) return;

    setItem(key, value);
  }, [value, key, autoSave, skipEmpty, isClient, setItem]);

  // Manual save function
  const save = useCallback(() => {
    return setItem(key, value);
  }, [key, value, setItem]);

  // Remove function
  const remove = useCallback(() => {
    return removeItem(key);
  }, [key, removeItem]);

  return {
    save,
    remove,
  };
}

/**
 * Hook to load a value from localStorage on mount
 * 
 * @param key - The localStorage key
 * @param onLoad - Callback to handle the loaded value
 * @returns Object with load function
 */
export function useLocalStorageLoad<T = string>(
  key: string,
  onLoad: (value: string | null) => void,
  options: {
    // Custom parser for the loaded value
    parser?: (value: string) => T;
  } = {}
) {
  const getItem = useStorageStore(state => state.getItem);
  const isClient = useStorageStore(state => state.isClient);

  // Load on mount
  useEffect(() => {
    if (!isClient) return;

    const value = getItem(key);

    if (value !== null) {
      if (options.parser) {
        try {
          const parsed = options.parser(value);
          onLoad(value);
        } catch (error) {
          console.error(`Failed to parse localStorage value for key "${key}":`, error);
        }
      } else {
        onLoad(value);
      }
    }
  }, [key, isClient, getItem, onLoad, options.parser]);

  // Manual load function
  const load = useCallback(() => {
    if (!isClient) return null;
    return getItem(key);
  }, [key, isClient, getItem]);

  return {
    load,
  };
}

/**
 * Combined hook for both loading and syncing with localStorage
 * 
 * @param key - The localStorage key
 * @param value - The current value to sync
 * @param onLoad - Callback to handle the loaded value on mount
 * @param options - Configuration options
 * @returns Object with storage operations
 */
export function useLocalStorage(
  key: string,
  value: string,
  onLoad: (value: string | null) => void,
  options: {
    autoSave?: boolean;
    skipEmpty?: boolean;
  } = {}
) {
  const { save, remove } = useLocalStorageSync(key, value, options);
  const { load } = useLocalStorageLoad(key, onLoad);

  return {
    save,
    remove,
    load,
  };
}

/**
 * Hook for draft-specific localStorage operations
 * Provides specialized functions for managing draft content
 * 
 * @param draftKey - The localStorage key for the draft
 * @param content - The current draft content
 * @param setContent - Function to update the draft content
 * @returns Object with draft-specific operations
 */
export function useDraftStorage(
  draftKey: string,
  content: string,
  setContent: (content: string) => void
) {
  const storage = useLocalStorage(
    draftKey,
    content,
    (loadedValue) => {
      if (loadedValue !== null) {
        setContent(loadedValue);
      }
    },
    {
      autoSave: true,
      skipEmpty: false,
    }
  );

  const clearDraft = useCallback(() => {
    setContent('');
    return storage.remove();
  }, [setContent, storage]);

  const saveDraft = useCallback(() => {
    return storage.save();
  }, [storage]);

  return {
    clearDraft,
    saveDraft,
    ...storage,
  };
}



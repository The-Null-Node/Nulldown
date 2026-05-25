import { useEffect, useCallback, useRef } from "react";
import useStorageStore from "../stores/storageStore";

export function useLocalStorageSync(
  key: string,
  value: string,
  options: {
    // Whether to automatically save when value changes
    autoSave?: boolean;
    // Whether to skip saving empty values
    skipEmpty?: boolean;
    // Debounce duration for auto-save writes
    debounceMs?: number;
  } = {}
) {
  const { autoSave = true, skipEmpty = false, debounceMs = 200 } = options;

  const setItem = useStorageStore((state) => state.setItem);
  const removeItem = useStorageStore((state) => state.removeItem);
  const isClient = useStorageStore((state) => state.isClient);

  // Auto-save effect
  useEffect(() => {
    if (!autoSave || !isClient) return;

    // Skip saving empty values if configured
    if (skipEmpty && !value) return;

    const timer = window.setTimeout(() => {
      void setItem(key, value);
    }, Math.max(0, debounceMs));

    return () => {
      window.clearTimeout(timer);
    };
  }, [value, key, autoSave, skipEmpty, debounceMs, isClient, setItem]);

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

export function useLocalStorageLoad<T = string>(
  key: string,
  onLoad: (value: string | null) => void,
  options: {
    // Custom parser for the loaded value
    parser?: (value: string) => T;
  } = {}
) {
  const getItem = useStorageStore((state) => state.getItem);
  const isClient = useStorageStore((state) => state.isClient);
  const parserRef = useRef(options.parser);
  const onLoadRef = useRef(onLoad);
  const loadedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    onLoadRef.current = onLoad;
  }, [onLoad]);

  useEffect(() => {
    parserRef.current = options.parser;
  }, [options.parser]);

  // Load on mount
  useEffect(() => {
    if (!isClient) return;
    if (loadedKeyRef.current === key) return;

    loadedKeyRef.current = key;
    let cancelled = false;

    const loadValue = async () => {
      const value = await getItem(key);

      if (cancelled) return;

      if (value !== null) {
        if (parserRef.current) {
          try {
            parserRef.current(value);
            onLoadRef.current(value);
          } catch (error) {
            console.error(
              `Failed to parse stored value for key "${key}":`,
              error,
            );
          }
        } else {
          onLoadRef.current(value);
        }
      }
    };

    void loadValue();

    return () => {
      cancelled = true;
    };
  }, [key, isClient, getItem]);

  // Manual load function
  const load = useCallback(async () => {
    if (!isClient) return null;
    return getItem(key);
  }, [key, isClient, getItem]);

  return {
    load,
  };
}

export function useLocalStorage(
  key: string,
  value: string,
  onLoad: (value: string | null) => void,
  options: {
    autoSave?: boolean;
    skipEmpty?: boolean;
    debounceMs?: number;
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
      debounceMs: 250,
    }
  );

  const clearDraft = useCallback(() => {
    setContent("");
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

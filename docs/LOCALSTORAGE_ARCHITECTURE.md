# LocalStorage Store Architecture

## Overview

This architecture provides atomic, type-safe localStorage operations through a Zustand store and React hooks.

## Components

### 1. Storage Store (`src/stores/storageStore.ts`)

A Zustand store that provides atomic localStorage operations:

- **State Management**: Tracks client environment and pending operations
- **Atomic Operations**: All operations are wrapped with try-catch and operation tracking
- **Batch Operations**: Support for multiple keys in a single atomic transaction
- **Error Handling**: Comprehensive error reporting without throwing

**Key Methods:**

- `initialize()` - Check if running in browser environment
- `setItem(key, value)` - Atomically set a localStorage item
- `getItem(key)` - Safely retrieve a localStorage item
- `removeItem(key)` - Atomically remove a localStorage item
- `clear()` - Clear all localStorage
- `batchSet(items)` - Set multiple items atomically
- `batchRemove(keys)` - Remove multiple items atomically

### 2. Storage Hooks (`src/hooks/useLocalStorage.ts`)

React hooks that provide convenient interfaces to the storage store:

#### `useLocalStorageSync(key, value, options)`

Auto-syncs a value to localStorage when it changes.

**Options:**

- `autoSave` - Automatically save on value changes (default: true)
- `skipEmpty` - Skip saving empty values (default: false)

#### `useLocalStorageLoad(key, onLoad, options)`

Loads a value from localStorage on component mount.

**Options:**

- `parser` - Custom parser for loaded values

#### `useLocalStorage(key, value, onLoad, options)`

Combined hook for both loading and syncing.

#### `useDraftStorage(draftKey, content, setContent)`

Specialized hook for draft content management with convenient methods:

- `clearDraft()` - Clears content and removes from localStorage atomically
- `saveDraft()` - Manually saves draft to localStorage
- `remove()` - Removes draft from localStorage
- `load()` - Manually loads draft from localStorage

### 3. EditorPage Integration

The EditorPage now uses the draft storage system:

```typescript
// Initialize storage
const initializeStorage = useStorageStore((state) => state.initialize);
const isClient = useStorageStore((state) => state.isClient);

// Use draft storage hook
const { clearDraft } = useDraftStorage(
  "nulldown_draft",
  markdown,
  setTextContent,
);

// Initialize storage on mount
useEffect(() => {
  initializeStorage();
}, [initializeStorage]);
```

**Key Benefits:**

1. **Atomic Operations**: All localStorage operations are guaranteed to complete or fail together
2. **Automatic Sync**: Draft is automatically saved when markdown changes
3. **Automatic Load**: Draft is automatically loaded on mount
4. **Clean API**: Single `clearDraft()` call replaces multiple operations
5. **Error Handling**: All operations return success/error status
6. **SSR Safe**: Checks for client environment before any localStorage access

## Usage Examples

### Basic Draft Management

```typescript
const { clearDraft, saveDraft } = useDraftStorage(
  "my_draft",
  content,
  setContent,
);

// Clear draft and content atomically
clearDraft();

// Manually save (auto-save is on by default)
saveDraft();
```

### Custom Storage Operations

```typescript
const setItem = useStorageStore((state) => state.setItem);
const result = setItem("my_key", "my_value");

if (!result.success) {
  console.error("Failed to save:", result.error);
}
```

### Batch Operations

```typescript
const batchSet = useStorageStore((state) => state.batchSet);
const result = batchSet({
  key1: "value1",
  key2: "value2",
  key3: "value3",
});
```

## Architecture Benefits

1. **Separation of Concerns**: Storage logic is separated from UI components
2. **Testability**: Storage operations can be mocked and tested independently
3. **Reusability**: Hooks can be used across any component needing localStorage
4. **Type Safety**: Full TypeScript support with proper types and interfaces
5. **Performance**: Optimized with Zustand's selector-based re-rendering
6. **Reliability**: Atomic operations ensure data consistency
7. **Developer Experience**: Clean, intuitive API with automatic synchronization

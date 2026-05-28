# Browser Storage Architecture

## Overview

Nulldown now uses a **void provider** model where each provider combines:

- storage
- crypto
- graph resolution/cache

The UI calls one provider interface for create/read/clone, while provider selection happens by mode (offline/online) or drop id.

## Storage Layers

### 1. Key-Value Storage (`src/stores/storageStore.ts`)

The storage store now resolves a backend at runtime:

- `indexeddb` (preferred)
- `localstorage` (fallback)
- `unavailable` (SSR / restricted environment)

It exposes async operations:

- `initialize()`
- `setItem(key, value)`
- `getItem(key)`
- `removeItem(key)`
- `clear()`
- `batchSet(items)`
- `batchRemove(keys)`

Migration keys are copied from localStorage to IndexedDB on initialization:

- `nulldown_draft`
- `nulldown_offline_mode`

### 2. IndexedDB Utilities (`src/lib/indexedDb.ts`)

Database: `nulldown`

Object stores:

- `kv` - generic key-value data (draft + settings)
- `drops` - offline shared drops (legacy plaintext payloads and sealed envelopes)

`kv` also stores:

- drop graph cache entries
- account vault state

### 3. Draft Hooks (`src/hooks/useLocalStorage.ts`)

Draft hooks are now async-safe and debounced:

- `useLocalStorageSync(...)` debounces autosaves
- `useLocalStorageLoad(...)` loads asynchronously on mount
- `useDraftStorage(...)` keeps draft behavior intact with async storage APIs

## Void Providers

### Provider Interface (`src/lib/void/provider.ts`)

The provider composes three ports:

- `VoidStorage`
- `VoidCrypto`
- `VoidGraph`

Runtime providers:

- Local provider: IndexedDB-backed storage + browser crypto + local graph cache
- Remote provider: API-backed storage + browser crypto + provider-managed graph semantics

### Shared Contract (`shared/drop/types.ts`)

Both frontend and functions use one canonical schema:

- `DropPayload` for legacy/plain payloads
- `DropEnvelopeV1` (`nmdn.drop.v1`) for encrypted/signed drops
- canonical JSON serialization helpers for signature payloads

## Crypto + Vault Model

### Browser Vault (`src/lib/void/vault/passkeyVault.ts`)

- Creates a local account vault with:
  - RSA-OAEP keypair for per-drop key wrapping
  - ECDSA keypair for device signatures
- Gated by WebAuthn passkey checks before crypto operations
- Keys are stored locally (IndexedDB-first, localStorage fallback)

### Sealed Envelope (`src/lib/void/crypto/browserVoidCrypto.ts`)

Each created drop is sealed as:

- AES-GCM encrypted content
- wrapped content key (account vault public key)
- device signature
- optional provider signature (if configured server-side)

No graph object is embedded in drop metadata.

## Offline / Online Modes

### Drop Store (`src/stores/dropStore.ts`)

The drop store now routes through providers:

- `offlineMode` (default: `false` / online)
- `hydrateOfflineMode()`
- `setOfflineMode(enabled)`
- `createDrop(payload)`
- `getDrop(id)`
- `resolveDropGraph(id)`

Offline ids are prefixed with `offline_`.

### Settings UI (`src/pages/editor/components/SettingsModal.tsx`)

Settings now includes an **Offline mode** toggle:

- Online mode: encrypt + upload sealed drop via `/api/store`
- Offline mode: encrypt + save sealed drop in IndexedDB and return `/d/offline_<id>` URL

### Share Flow (`src/pages/editor/hooks/useShareDrop.ts`)

Share now calls `createDrop(...)` and receives provider-scoped output:

```json
{
  "id": "...",
  "url": "...",
  "scope": "local | remote"
}
```

## Read + Clone Behavior

### Drop view (`src/pages/DropViewPage.tsx`)

- Uses `getDrop(id)` from the drop store
- Provider selection happens internally by id

### Editor clone (`src/pages/EditorPage.tsx`)

- Uses `getDrop(cloneId)` regardless of mode
- Encrypted envelopes are decrypted through the vault path

## Notes

- Offline links are local-only and work in the same browser profile/device.
- Online drops are provider-blind (encrypted before upload).
- Provider signatures are added when `PROVIDER_SIGNING_PRIVATE_JWK` is configured in Functions.
- Theme preference storage remains in localStorage (`src/theme/themeContext.tsx`).
- Draft persistence is now async and no longer blocks typing with synchronous writes.

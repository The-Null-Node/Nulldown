# Browser Storage Architecture

## Overview

Nulldown uses browser drop provider ports that compose:

- storage
- crypto
- graph resolution/cache

The UI calls the drop store, which coordinates local and remote provider ports.
Creates are staged locally first; online mode then publishes through the remote
port. Reads try local storage before falling back to the remote port.

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

## Drop Providers

### Provider Interface (`src/lib/drop/provider.ts`)

The provider composes three ports:

- `DropStorage`
- `DropCrypto`
- `DropGraphResolver`

Provider ports:

- Local provider: IndexedDB-backed storage + browser crypto + local graph cache
- Remote provider: API-backed storage + browser crypto + remote graph cache

### Shared Contract (`shared/drop/types.ts`)

Both frontend and functions use one canonical schema:

- `DropPayload` for legacy/plain payloads
- `DropEnvelope` for encrypted/signed drops; the private v1 codec preserves the `nmdn.drop.v1` wire schema
- canonical JSON serialization helpers for signature payloads

## Crypto + Vault Model

### Browser Vault (`src/lib/auth/vault/passkey-vault.ts`)

- Creates a local account vault with:
  - RSA-OAEP keypair for per-drop key wrapping
  - ECDSA keypair for device signatures
- Gated by WebAuthn passkey checks before crypto operations
- Keys are stored locally (IndexedDB-first, localStorage fallback)

### Sealed Envelope (`src/lib/crypto/browser-drop-crypto.ts`)

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

### Settings UI (`src/pages/editor/components/SettingsModal.tsx`)

Settings now includes an **Offline mode** toggle:

- Online mode: encrypt + save locally, then publish through `/api/store`
- Offline mode: encrypt + save in IndexedDB and return a local-only drop URL

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
- Resolution tries the local provider before the remote provider

### Editor clone (`src/pages/EditorPage.tsx`)

- Uses `getDrop(cloneId)` regardless of mode
- Encrypted envelopes are decrypted through the vault path

## Notes

- Offline links are local-only and work in the same browser profile/device.
- Remote storage receives sealed envelopes; provider-assisted unlock remains an
  explicit envelope policy.
- Provider signatures are added when `PROVIDER_SIGNING_PRIVATE_JWK` is configured in Functions.
- Theme preference storage remains in localStorage (`src/theme/themeContext.tsx`).
- Draft persistence is now async and no longer blocks typing with synchronous writes.

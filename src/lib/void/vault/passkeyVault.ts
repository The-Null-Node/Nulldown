/*
The passkey vault stores the account keypair used to wrap content keys and sign drop
envelopes. IndexedDB is the preferred backing store, while localStorage is only a
fallback so existing browsers can still unlock previously created vaults.
*/

import {
  getKvItem,
  getKvValue,
  isIndexedDbSupported,
  setKvValue,
  setKvValues,
} from "../../indexedDb";
import {
  ACCOUNT_RECOVERY_PAYLOAD_SCHEMA_V1,
  parseAccountRecoveryPayload,
  type AccountRecoveryPayloadV1,
} from "../../../../shared/auth/recovery";
import { fromBase64, toBase64 } from "../crypto/base64";
import {
  DROP_DEVICE_DELEGATION_SCHEMA,
  DROP_DEVICE_DELEGATION_VERSION,
  isDropDelegateSigningPublicJwk,
  serializeDropDeviceDelegationForSignature,
  type DropDeviceDelegation,
} from "../../../../shared/drop/deviceDelegation";

const DEFAULT_VAULT_RECORD_KEY = "nulldown_account_vault_v1";
const DEFAULT_UNLOCK_TTL_MS = 8 * 60 * 60 * 1000;
const UNLOCK_LEASE_SUFFIX = "_unlock_lease_v1";
export const PASSKEY_PROTECTION_STORAGE_KEY = "nulldown_passkey_protection";
export const LOCAL_ACCOUNT_VAULT_CHANGED_EVENT =
  "nulldown:local-account-vault-changed";

interface VaultRecordV1 {
  version: 1;
  accountId: string;
  ownerUserId?: string;
  encryptionKid: string;
  signingKid: string;
  passkeyCredentialId?: string;
  encryptionPublicJwk: JsonWebKey;
  encryptionPrivateJwk: JsonWebKey;
  signingPublicJwk: JsonWebKey;
  signingPrivateJwk: JsonWebKey;
  createdAt: number;
  updatedAt: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isBase64Url = (value: unknown, minimumLength: number): value is string =>
  typeof value === "string" &&
  value.length >= minimumLength &&
  /^[A-Za-z0-9_-]+$/u.test(value);

const isRsaPublicJwk = (value: unknown): value is JsonWebKey =>
  isRecord(value) &&
  value.kty === "RSA" &&
  isBase64Url(value.n, 300) &&
  isBase64Url(value.e, 3);

const isRsaPrivateJwk = (value: unknown): value is JsonWebKey =>
  isRsaPublicJwk(value) &&
  isBase64Url(value.d, 300) &&
  isBase64Url(value.p, 150) &&
  isBase64Url(value.q, 150) &&
  isBase64Url(value.dp, 150) &&
  isBase64Url(value.dq, 150) &&
  isBase64Url(value.qi, 150);

const isEcPublicJwk = (value: unknown): value is JsonWebKey =>
  isRecord(value) &&
  value.kty === "EC" &&
  value.crv === "P-256" &&
  isBase64Url(value.x, 43) &&
  value.x.length === 43 &&
  isBase64Url(value.y, 43) &&
  value.y.length === 43;

const isEcPrivateJwk = (value: unknown): value is JsonWebKey =>
  isEcPublicJwk(value) && isBase64Url(value.d, 43) && value.d.length === 43;

const isVaultRecord = (value: unknown): value is VaultRecordV1 =>
  isRecord(value) &&
  value.version === 1 &&
  typeof value.accountId === "string" &&
  Boolean(value.accountId) &&
  (value.ownerUserId === undefined || typeof value.ownerUserId === "string") &&
  typeof value.encryptionKid === "string" &&
  Boolean(value.encryptionKid) &&
  typeof value.signingKid === "string" &&
  Boolean(value.signingKid) &&
  (value.passkeyCredentialId === undefined ||
    typeof value.passkeyCredentialId === "string") &&
  isRsaPublicJwk(value.encryptionPublicJwk) &&
  isRsaPrivateJwk(value.encryptionPrivateJwk) &&
  isEcPublicJwk(value.signingPublicJwk) &&
  isEcPrivateJwk(value.signingPrivateJwk) &&
  typeof value.createdAt === "number" &&
  Number.isSafeInteger(value.createdAt) &&
  value.createdAt >= 0 &&
  typeof value.updatedAt === "number" &&
  Number.isSafeInteger(value.updatedAt) &&
  value.updatedAt >= 0;

interface UnlockLeaseV1 {
  version: 1;
  accountId: string;
  expiresAt: number;
}

export interface UnlockedVault {
  accountId: string;
  encryptionKid: string;
  signingKid: string;
  encryptionPublicJwk: JsonWebKey;
  signingPublicJwk: JsonWebKey;
  encryptionPublicKey: CryptoKey;
  encryptionPrivateKey: CryptoKey;
  signingPublicKey: CryptoKey;
  signingPrivateKey: CryptoKey;
}

export interface PasskeyVaultOptions {
  storageKey?: string;
  unlockTtlMs?: number;
}

/** Public ticket details the unlocked account vault signs for a CLI device. */
export interface DeviceDelegationRequest {
  accountId: string;
  credentialId: string;
  delegateSigningPublicJwk: JsonWebKey;
  expiresAt: number;
}

let activeOpenAuthUserId: string | null = null;

/** Sets the browser user allowed to activate user-bound local V1 key material. */
export const setActiveVaultUser = (userId: string | null): void => {
  activeOpenAuthUserId = userId;
};

/** Returns the OpenAuth user currently allowed to activate user-bound local keys. */
export const getActiveVaultUser = (): string | null => activeOpenAuthUserId;

const notifyLocalAccountVaultChanged = (): void => {
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    window.dispatchEvent(new Event(LOCAL_ACCOUNT_VAULT_CHANGED_EVENT));
  }
};

export class PasskeyVault {
  private readonly storageKey: string;
  private readonly unlockLeaseKey: string;
  private readonly unlockTtlMs: number;
  private unlockState: {
    accountId: string;
    expiresAt: number;
    passkeyProtected: boolean;
  } | null = null;

  constructor(options: PasskeyVaultOptions = {}) {
    this.storageKey = options.storageKey ?? DEFAULT_VAULT_RECORD_KEY;
    this.unlockLeaseKey = `${this.storageKey}${UNLOCK_LEASE_SUFFIX}`;
    this.unlockTtlMs = options.unlockTtlMs ?? DEFAULT_UNLOCK_TTL_MS;
  }

  async getUnlockedVault(): Promise<UnlockedVault> {
    const record = await this.ensureVaultRecord();
    this.assertRecordOwner(record);
    const unlockedRecord = await this.ensureVaultUnlocked(record);

    const [
      encryptionPublicKey,
      encryptionPrivateKey,
      signingPublicKey,
      signingPrivateKey,
    ] = await Promise.all([
      this.importRsaPublicKey(unlockedRecord.encryptionPublicJwk),
      this.importRsaPrivateKey(unlockedRecord.encryptionPrivateJwk),
      this.importSigningPublicKey(unlockedRecord.signingPublicJwk),
      this.importSigningPrivateKey(unlockedRecord.signingPrivateJwk),
    ]);

    return {
      accountId: unlockedRecord.accountId,
      encryptionKid: unlockedRecord.encryptionKid,
      signingKid: unlockedRecord.signingKid,
      encryptionPublicJwk: unlockedRecord.encryptionPublicJwk,
      signingPublicJwk: unlockedRecord.signingPublicJwk,
      encryptionPublicKey,
      encryptionPrivateKey,
      signingPublicKey,
      signingPrivateKey,
    };
  }

  /** Signs a bounded CLI delegation without exporting either account private key. */
  async signDeviceDelegation(
    input: DeviceDelegationRequest,
  ): Promise<DropDeviceDelegation> {
    if (!isDropDelegateSigningPublicJwk(input.delegateSigningPublicJwk)) {
      throw new Error("CLI authoring key is invalid.");
    }
    if (!Number.isFinite(input.expiresAt) || input.expiresAt <= Date.now()) {
      throw new Error("CLI authorization has expired.");
    }

    const record = await this.loadVaultRecord();
    if (!record) throw new Error("Unlock the matching local account vault to authorize this CLI.");
    this.assertRecordOwner(record);
    const unlockedRecord = await this.ensureVaultUnlocked(record);
    if (unlockedRecord.accountId !== input.accountId) {
      throw new Error("The unlocked local vault does not match this CLI account.");
    }

    const signingPrivateKey = await this.importSigningPrivateKey(
      unlockedRecord.signingPrivateJwk,
    );
    const issuedAt = Date.now();
    const signable = {
      schema: DROP_DEVICE_DELEGATION_SCHEMA,
      version: DROP_DEVICE_DELEGATION_VERSION,
      accountId: unlockedRecord.accountId,
      credentialId: input.credentialId,
      delegateSigningPublicJwk: input.delegateSigningPublicJwk,
      encryptionKid: unlockedRecord.encryptionKid,
      encryptionPublicJwk: unlockedRecord.encryptionPublicJwk,
      issuedAt,
      expiresAt: input.expiresAt,
    };
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      signingPrivateKey,
      new TextEncoder().encode(serializeDropDeviceDelegationForSignature(signable)),
    );
    return {
      ...signable,
      signature: {
        kid: unlockedRecord.signingKid,
        alg: "ECDSA_P256_SHA256",
        sig: toBase64(signature),
      },
    };
  }

  /** Reports whether this storage slot exists without creating or unlocking an account. */
  async hasVaultRecord(): Promise<boolean> {
    return (await this.loadVaultRecord()) !== null;
  }

  /** Reads the current account id without creating or unlocking a vault. */
  async getAccountId(): Promise<string | null> {
    return (await this.loadVaultRecord())?.accountId ?? null;
  }

  /** Reads non-secret ownership metadata without creating or unlocking a vault. */
  async getAccountSummary(): Promise<{ accountId: string; ownerUserId: string | null } | null> {
    const record = await this.loadVaultRecord();
    return record
      ? { accountId: record.accountId, ownerUserId: record.ownerUserId ?? null }
      : null;
  }

  /** Marks an existing V1 account as locally activatable only by its bound user. */
  async assignOwner(userId: string, accountId: string): Promise<boolean> {
    const record = await this.loadVaultRecord();
    if (!record || record.accountId !== accountId) {
      throw new Error("Current account changed during sync setup.");
    }
    if (activeOpenAuthUserId !== userId) {
      throw new Error("Signed-in user changed during sync setup.");
    }
    if (record.ownerUserId && record.ownerUserId !== userId) {
      throw new Error("Local account belongs to a different signed-in user.");
    }
    if (record.ownerUserId === userId) return false;
    await this.saveVaultRecordStrict({
      ...record,
      ownerUserId: userId,
      updatedAt: Date.now(),
    });
    return true;
  }

  /** Exports current V1 key material only after applying the existing local unlock gate. */
  async exportRecoveryPayload(): Promise<AccountRecoveryPayloadV1> {
    const record = await this.loadVaultRecord();
    if (!record) throw new Error("No local account is available to sync.");
    this.assertRecordOwner(record);
    const unlocked = await this.ensureVaultUnlocked(record);
    return {
      schema: ACCOUNT_RECOVERY_PAYLOAD_SCHEMA_V1,
      version: 1,
      accountId: unlocked.accountId,
      encryptionKid: unlocked.encryptionKid,
      signingKid: unlocked.signingKid,
      encryptionPublicJwk: unlocked.encryptionPublicJwk,
      encryptionPrivateJwk: unlocked.encryptionPrivateJwk,
      signingPublicJwk: unlocked.signingPublicJwk,
      signingPrivateJwk: unlocked.signingPrivateJwk,
      createdAt: unlocked.createdAt,
    };
  }

  /** Installs validated recovery data while preserving any different existing account. */
  async installRecoveryPayload(
    value: unknown,
    ownerUserId?: string,
    canInstall: () => boolean = () => true,
    indexedDbGuard?: { key: string; expectedValue: unknown },
  ): Promise<{ accountId: string; preservedAccountId: string | null }> {
    const payload = parseAccountRecoveryPayload(value);
    if (!payload) throw new TypeError("Recovered account data is invalid.");
    await Promise.all([
      this.importRsaPublicKey(payload.encryptionPublicJwk),
      this.importRsaPrivateKey(payload.encryptionPrivateJwk),
      this.importSigningPublicKey(payload.signingPublicJwk),
      this.importSigningPrivateKey(payload.signingPrivateJwk),
    ]);

    const existing = await this.loadVaultRecord();
    const now = Date.now();
    const record: VaultRecordV1 = {
      version: 1,
      accountId: payload.accountId,
      ...(ownerUserId ? { ownerUserId } : {}),
      encryptionKid: payload.encryptionKid,
      signingKid: payload.signingKid,
      encryptionPublicJwk: payload.encryptionPublicJwk,
      encryptionPrivateJwk: payload.encryptionPrivateJwk,
      signingPublicJwk: payload.signingPublicJwk,
      signingPrivateJwk: payload.signingPrivateJwk,
      createdAt: payload.createdAt,
      updatedAt: now,
    };
    const preservedAccountId =
      existing && existing.accountId !== payload.accountId ? existing.accountId : null;

    if (isIndexedDbSupported()) {
      const entries = [{ key: this.storageKey, value: record }];
      if (preservedAccountId && existing) {
        entries.unshift({
          key: `${this.storageKey}:account:${preservedAccountId}`,
          value: existing,
        });
      }
      await setKvValues(entries, canInstall, indexedDbGuard);
    } else {
      if (typeof window === "undefined") {
        throw new Error("Browser storage is unavailable for account recovery.");
      }
      if (preservedAccountId && existing) {
        if (!canInstall()) throw new Error("Account recovery was cancelled.");
        window.localStorage.setItem(
          `${this.storageKey}:account:${preservedAccountId}`,
          JSON.stringify(existing),
        );
      }
      if (!canInstall()) throw new Error("Account recovery was cancelled.");
      window.localStorage.setItem(this.storageKey, JSON.stringify(record));
    }

    this.unlockState = null;
    this.clearUnlockLease();
    notifyLocalAccountVaultChanged();
    return { accountId: payload.accountId, preservedAccountId };
  }

  private assertRecordOwner(record: VaultRecordV1): void {
    if (record.ownerUserId && record.ownerUserId !== activeOpenAuthUserId) {
      throw new Error("Sign in as the account owner to unlock synced content.");
    }
  }

  private supportsPasskeys() {
    if (typeof window === "undefined") return false;
    if (!window.isSecureContext) return false;
    return typeof window.PublicKeyCredential !== "undefined";
  }

  private randomChallenge() {
    return crypto.getRandomValues(new Uint8Array(32));
  }

  private createKid(prefix: string) {
    const randomPart =
      typeof crypto.randomUUID === "function"
        ? crypto.randomUUID().replace(/-/g, "")
        : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    return `${prefix}_${randomPart.slice(0, 16)}`;
  }

  private async createPasskeyCredential(accountId: string): Promise<string> {
    if (!this.supportsPasskeys()) {
      throw new Error(
        "Passkeys are unavailable. Use a secure context (HTTPS) with WebAuthn support.",
      );
    }

    const userBytes = new TextEncoder().encode(accountId.slice(0, 63));

    const credential = (await navigator.credentials.create({
      publicKey: {
        challenge: this.randomChallenge(),
        rp: {
          name: "Nulldown",
        },
        user: {
          id: userBytes,
          name: accountId,
          displayName: "Nulldown Account Vault",
        },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        timeout: 60_000,
        attestation: "none",
        authenticatorSelection: {
          residentKey: "preferred",
          userVerification: "preferred",
        },
      },
    })) as PublicKeyCredential | null;

    if (!credential) {
      throw new Error("Passkey registration failed.");
    }

    return toBase64(credential.rawId);
  }

  private async assertPasskey(credentialId: string): Promise<void> {
    if (!this.supportsPasskeys()) {
      throw new Error(
        "Passkeys are unavailable. Use a secure context (HTTPS) with WebAuthn support.",
      );
    }

    const credential = (await navigator.credentials.get({
      publicKey: {
        challenge: this.randomChallenge(),
        timeout: 60_000,
        userVerification: "preferred",
        allowCredentials: [
          {
            type: "public-key",
            id: fromBase64(credentialId),
          },
        ],
      },
    })) as PublicKeyCredential | null;

    if (!credential) {
      throw new Error("Passkey verification failed.");
    }
  }

  private async createVaultRecord(): Promise<VaultRecordV1> {
    const accountId =
      typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

    const [encryptionPair, signingPair] = (await Promise.all([
      crypto.subtle.generateKey(
        {
          name: "RSA-OAEP",
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: "SHA-256",
        },
        true,
        ["encrypt", "decrypt"],
      ),
      crypto.subtle.generateKey(
        {
          name: "ECDSA",
          namedCurve: "P-256",
        },
        true,
        ["sign", "verify"],
      ),
    ])) as [CryptoKeyPair, CryptoKeyPair];

    const [
      encryptionPublicJwk,
      encryptionPrivateJwk,
      signingPublicJwk,
      signingPrivateJwk,
    ] = await Promise.all([
      crypto.subtle.exportKey("jwk", encryptionPair.publicKey),
      crypto.subtle.exportKey("jwk", encryptionPair.privateKey),
      crypto.subtle.exportKey("jwk", signingPair.publicKey),
      crypto.subtle.exportKey("jwk", signingPair.privateKey),
    ]);

    const passkeyProtectionEnabled = await this.isPasskeyProtectionEnabled();
    const passkeyCredentialId = passkeyProtectionEnabled
      ? await this.createPasskeyCredential(accountId)
      : undefined;
    const now = Date.now();

    return {
      version: 1,
      accountId,
      encryptionKid: this.createKid("enc"),
      signingKid: this.createKid("sig"),
      passkeyCredentialId,
      encryptionPublicJwk,
      encryptionPrivateJwk,
      signingPublicJwk,
      signingPrivateJwk,
      createdAt: now,
      updatedAt: now,
    };
  }

  private loadRecordFromLocalStorage(): VaultRecordV1 | null {
    if (typeof window === "undefined") return null;
    const raw = window.localStorage.getItem(this.storageKey);
    if (!raw) return null;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error("Local account vault is unreadable.");
    }
    if (!isVaultRecord(value)) {
      throw new Error("Local account vault is invalid.");
    }
    return value;
  }

  private isValidUnlockLease(value: unknown): value is UnlockLeaseV1 {
    if (typeof value !== "object" || value === null) {
      return false;
    }

    const lease = value as Record<string, unknown>;
    return (
      lease.version === 1 &&
      typeof lease.accountId === "string" &&
      lease.accountId.length > 0 &&
      typeof lease.expiresAt === "number" &&
      Number.isFinite(lease.expiresAt)
    );
  }

  private loadUnlockLease(): UnlockLeaseV1 | null {
    if (typeof window === "undefined") return null;

    try {
      const raw = window.localStorage.getItem(this.unlockLeaseKey);
      if (!raw) return null;

      const parsed = JSON.parse(raw) as unknown;
      if (!this.isValidUnlockLease(parsed)) {
        this.clearUnlockLease();
        return null;
      }

      return parsed;
    } catch {
      this.clearUnlockLease();
      return null;
    }
  }

  private saveUnlockLease(lease: UnlockLeaseV1) {
    if (typeof window === "undefined") return;

    try {
      window.localStorage.setItem(this.unlockLeaseKey, JSON.stringify(lease));
    } catch {
      // Losing the UX lease only forces another prompt; it does not destroy the vault itself.
    }
  }

  private clearUnlockLease() {
    if (typeof window === "undefined") return;

    try {
      window.localStorage.removeItem(this.unlockLeaseKey);
    } catch {
      // Lease cleanup is best-effort because stale leases are revalidated on the next unlock.
    }
  }

  private saveRecordToLocalStorage(record: VaultRecordV1) {
    if (typeof window === "undefined") return;

    try {
      window.localStorage.setItem(this.storageKey, JSON.stringify(record));
    } catch {
      // IndexedDB remains the primary store; this fallback write is only for degraded browsers.
    }
  }

  private parsePasskeyProtection(value: string | null): boolean {
    return value === null ? false : value === "1" || value === "true";
  }

  private readPasskeyProtectionFromLocalStorage(): boolean | null {
    if (typeof window === "undefined") {
      return null;
    }

    try {
      const persisted = window.localStorage.getItem(
        PASSKEY_PROTECTION_STORAGE_KEY,
      );
      if (persisted === null) {
        return null;
      }

      return this.parsePasskeyProtection(persisted);
    } catch {
      return null;
    }
  }

  private async isPasskeyProtectionEnabled(): Promise<boolean> {
    if (isIndexedDbSupported()) {
      try {
        const persisted = await getKvItem(PASSKEY_PROTECTION_STORAGE_KEY);
        if (persisted !== null) {
          return this.parsePasskeyProtection(persisted);
        }
      } catch (error) {
        console.error(
          "Failed to read passkey protection preference from IndexedDB:",
          error,
        );
      }
    }

    const localValue = this.readPasskeyProtectionFromLocalStorage();
    if (localValue !== null) {
      return localValue;
    }

    return false;
  }

  private async ensurePasskeyCredential(
    record: VaultRecordV1,
  ): Promise<VaultRecordV1> {
    if (record.passkeyCredentialId) {
      return record;
    }

    const passkeyCredentialId = await this.createPasskeyCredential(
      record.accountId,
    );
    const upgraded: VaultRecordV1 = {
      ...record,
      passkeyCredentialId,
      updatedAt: Date.now(),
    };

    await this.saveVaultRecord(upgraded);
    return upgraded;
  }

  private async loadVaultRecord(): Promise<VaultRecordV1 | null> {
    if (isIndexedDbSupported()) {
      const record = await getKvValue<VaultRecordV1>(this.storageKey);
      if (record) {
        if (!isVaultRecord(record)) {
          throw new Error("IndexedDB account vault is invalid.");
        }
        return record;
      }
    }

    return this.loadRecordFromLocalStorage();
  }

  private async saveVaultRecord(record: VaultRecordV1): Promise<void> {
    if (isIndexedDbSupported()) {
      try {
        await setKvValue(this.storageKey, record);
        notifyLocalAccountVaultChanged();
        return;
      } catch (error) {
        console.error("Failed to persist account vault to IndexedDB:", error);
      }
    }

    this.saveRecordToLocalStorage(record);
    notifyLocalAccountVaultChanged();
  }

  private async saveVaultRecordStrict(record: VaultRecordV1): Promise<void> {
    if (isIndexedDbSupported()) {
      await setKvValue(this.storageKey, record);
      notifyLocalAccountVaultChanged();
      return;
    }
    if (typeof window === "undefined") {
      throw new Error("Browser storage is unavailable.");
    }
    window.localStorage.setItem(this.storageKey, JSON.stringify(record));
    notifyLocalAccountVaultChanged();
  }

  private async ensureVaultRecord(): Promise<VaultRecordV1> {
    const existing = await this.loadVaultRecord();
    if (existing) return existing;

    const created = await this.createVaultRecord();
    await this.saveVaultRecord(created);
    return created;
  }

  private async ensureVaultUnlocked(
    record: VaultRecordV1,
  ): Promise<VaultRecordV1> {
    const passkeyProtectionEnabled = await this.isPasskeyProtectionEnabled();
    if (!passkeyProtectionEnabled) {
      this.unlockState = null;
      this.clearUnlockLease();
      return record;
    }

    const guardedRecord = await this.ensurePasskeyCredential(record);
    const now = Date.now();
    if (
      this.unlockState &&
      this.unlockState.passkeyProtected &&
      this.unlockState.accountId === guardedRecord.accountId &&
      this.unlockState.expiresAt > now
    ) {
      return guardedRecord;
    }

    const persistedLease = this.loadUnlockLease();
    if (persistedLease) {
      if (
        persistedLease.accountId === guardedRecord.accountId &&
        persistedLease.expiresAt > now
      ) {
        // The lease is a local prompt throttle, not an authorization token shared with the server.
        this.unlockState = {
          accountId: persistedLease.accountId,
          expiresAt: persistedLease.expiresAt,
          passkeyProtected: true,
        };
        return guardedRecord;
      }

      this.clearUnlockLease();
    }

    const credentialId = guardedRecord.passkeyCredentialId;
    if (!credentialId) {
      throw new Error("Passkey credential is unavailable for this vault.");
    }

    await this.assertPasskey(credentialId);

    const expiresAt = Date.now() + this.unlockTtlMs;
    this.unlockState = {
      accountId: guardedRecord.accountId,
      expiresAt,
      passkeyProtected: true,
    };
    this.saveUnlockLease({
      version: 1,
      accountId: guardedRecord.accountId,
      expiresAt,
    });

    return guardedRecord;
  }

  private importRsaPublicKey(jwk: JsonWebKey) {
    return crypto.subtle.importKey(
      "jwk",
      jwk,
      {
        name: "RSA-OAEP",
        hash: "SHA-256",
      },
      false,
      ["encrypt"],
    );
  }

  private importRsaPrivateKey(jwk: JsonWebKey) {
    return crypto.subtle.importKey(
      "jwk",
      jwk,
      {
        name: "RSA-OAEP",
        hash: "SHA-256",
      },
      false,
      ["decrypt"],
    );
  }

  private importSigningPublicKey(jwk: JsonWebKey) {
    return crypto.subtle.importKey(
      "jwk",
      jwk,
      {
        name: "ECDSA",
        namedCurve: "P-256",
      },
      false,
      ["verify"],
    );
  }

  private importSigningPrivateKey(jwk: JsonWebKey) {
    return crypto.subtle.importKey(
      "jwk",
      jwk,
      {
        name: "ECDSA",
        namedCurve: "P-256",
      },
      false,
      ["sign"],
    );
  }
}

export const createPasskeyVault = (options: PasskeyVaultOptions = {}) =>
  new PasskeyVault(options);

const defaultPasskeyVault = createPasskeyVault();

export const getUnlockedVault = () => defaultPasskeyVault.getUnlockedVault();

/** Signs a CLI delegation with the current unlocked local account vault. */
export const signLocalDeviceDelegation = (input: DeviceDelegationRequest) =>
  defaultPasskeyVault.signDeviceDelegation(input);

export const hasLocalAccountVault = () => defaultPasskeyVault.hasVaultRecord();

export const getLocalAccountId = () => defaultPasskeyVault.getAccountId();

export const getLocalAccountSummary = () => defaultPasskeyVault.getAccountSummary();

export const assignLocalAccountOwner = (userId: string, accountId: string) =>
  defaultPasskeyVault.assignOwner(userId, accountId);

export const exportLocalAccountRecoveryPayload = () =>
  defaultPasskeyVault.exportRecoveryPayload();

export const installLocalAccountRecoveryPayload = (
  payload: unknown,
  ownerUserId?: string,
  canInstall?: () => boolean,
  indexedDbGuard?: { key: string; expectedValue: unknown },
) =>
  defaultPasskeyVault.installRecoveryPayload(
    payload,
    ownerUserId,
    canInstall,
    indexedDbGuard,
  );

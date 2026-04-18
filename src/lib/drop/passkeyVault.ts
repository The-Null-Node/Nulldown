import {
  getKvItem,
  getKvValue,
  isIndexedDbSupported,
  setKvValue,
} from "../indexedDb";
import { fromBase64, toBase64 } from "./base64";

const DEFAULT_VAULT_RECORD_KEY = "nulldown_account_vault_v1";
const DEFAULT_UNLOCK_TTL_MS = 8 * 60 * 60 * 1000;
const UNLOCK_LEASE_SUFFIX = "_unlock_lease_v1";
export const PASSKEY_PROTECTION_STORAGE_KEY = "nulldown_passkey_protection";

interface VaultRecordV1 {
  version: 1;
  accountId: string;
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

const textEncoder = new TextEncoder();

export class PasskeyVault {
  private readonly storageKey: string;
  private readonly unlockLeaseKey: string;
  private readonly unlockTtlMs: number;
  private unlockState:
    | { accountId: string; expiresAt: number; passkeyProtected: boolean }
    | null = null;

  constructor(options: PasskeyVaultOptions = {}) {
    this.storageKey = options.storageKey ?? DEFAULT_VAULT_RECORD_KEY;
    this.unlockLeaseKey = `${this.storageKey}${UNLOCK_LEASE_SUFFIX}`;
    this.unlockTtlMs = options.unlockTtlMs ?? DEFAULT_UNLOCK_TTL_MS;
  }

  async getUnlockedVault(): Promise<UnlockedVault> {
    const record = await this.ensureVaultRecord();
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

    const userBytes = textEncoder.encode(accountId.slice(0, 63));

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

    try {
      const raw = window.localStorage.getItem(this.storageKey);
      if (!raw) return null;
      return JSON.parse(raw) as VaultRecordV1;
    } catch {
      return null;
    }
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
      // ignore fallback failures
    }
  }

  private clearUnlockLease() {
    if (typeof window === "undefined") return;

    try {
      window.localStorage.removeItem(this.unlockLeaseKey);
    } catch {
      // ignore fallback failures
    }
  }

  private saveRecordToLocalStorage(record: VaultRecordV1) {
    if (typeof window === "undefined") return;

    try {
      window.localStorage.setItem(this.storageKey, JSON.stringify(record));
    } catch {
      // ignore fallback failures
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

    const passkeyCredentialId = await this.createPasskeyCredential(record.accountId);
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
      try {
        const record = await getKvValue<VaultRecordV1>(this.storageKey);
        if (record) return record;
      } catch (error) {
        console.error("Failed to load account vault from IndexedDB:", error);
      }
    }

    return this.loadRecordFromLocalStorage();
  }

  private async saveVaultRecord(record: VaultRecordV1): Promise<void> {
    if (isIndexedDbSupported()) {
      try {
        await setKvValue(this.storageKey, record);
        return;
      } catch (error) {
        console.error("Failed to persist account vault to IndexedDB:", error);
      }
    }

    this.saveRecordToLocalStorage(record);
  }

  private async ensureVaultRecord(): Promise<VaultRecordV1> {
    const existing = await this.loadVaultRecord();
    if (existing) return existing;

    const created = await this.createVaultRecord();
    await this.saveVaultRecord(created);
    return created;
  }

  private async ensureVaultUnlocked(record: VaultRecordV1): Promise<VaultRecordV1> {
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

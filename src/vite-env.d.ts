/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PROVIDER_SIGNING_PUBLIC_JWK?: string;
  readonly VITE_PROVIDER_ENCRYPTION_PUBLIC_JWK?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

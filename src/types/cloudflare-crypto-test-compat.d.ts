/** Test-only Web Crypto overloads for asymmetric fixture keys. */
interface SubtleCrypto {
  generateKey(
    algorithm: AlgorithmIdentifier | RsaHashedKeyGenParams | EcKeyGenParams,
    extractable: boolean,
    keyUsages: readonly KeyUsage[],
  ): Promise<CryptoKeyPair>;
  exportKey(format: "jwk", key: CryptoKey): Promise<JsonWebKey>;
}

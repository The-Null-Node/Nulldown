/** One-time server challenge signed by the current account signing key. */
export interface AccountBindingChallenge {
  challengeId: string;
  nonce: string;
  userId: string;
  accountId: string;
  origin: string;
  signingKeyFingerprint: string;
  issuedAt: number;
  expiresAt: number;
}

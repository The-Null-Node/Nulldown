import { jest } from "@jest/globals";
import {
  PasskeyVault,
  createPasskeyVault,
  getUnlockedVault,
  type UnlockedVault,
} from "./passkeyVault";

describe("passkey vault", () => {
  it("creates a PasskeyVault instance with createPasskeyVault", () => {
    const vault = createPasskeyVault();
    expect(vault).toBeInstanceOf(PasskeyVault);
  });

  it("delegates getUnlockedVault to the default vault instance", async () => {
    const unlockedVault: UnlockedVault = {
      accountId: "account-id",
      encryptionKid: "enc-kid",
      signingKid: "sig-kid",
      encryptionPublicKey: {} as CryptoKey,
      encryptionPrivateKey: {} as CryptoKey,
      signingPublicKey: {} as CryptoKey,
      signingPrivateKey: {} as CryptoKey,
    };

    const spy = jest
      .spyOn(PasskeyVault.prototype, "getUnlockedVault")
      .mockResolvedValue(unlockedVault);

    await expect(getUnlockedVault()).resolves.toEqual(unlockedVault);
    expect(spy).toHaveBeenCalledTimes(1);

    spy.mockRestore();
  });
});

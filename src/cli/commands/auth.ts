import { flagString } from "../core/args";
import { hasFlag } from "../core/args";
import type { CliCommand } from "../core/command";
import {
  decryptCliCredentialEnvelope,
  generateCliDeviceKeyPair,
  isCliCredentialForBaseUrl,
  type CliDeviceKeyPair,
} from "../auth";
import type { CliCredentialBundleV1 } from "../../../shared/auth/cliDevice";
import type { NulldownRuntime } from "../runtime/types";

/** Dependencies used by modular auth commands. */
export interface AuthCommandDependencies {
  /** Runtime facade for auth operations. */
  runtime: NulldownRuntime;
  /** Prints command output using the active CLI output policy. */
  print(value: unknown, human?: string): void;
  /** Reads command input from a file path or stdin marker. */
  readInput(path: string | null): Promise<string>;
  /** API origin used to scope persisted credentials. */
  baseUrl(): string;
  /** Path used for the local refreshable credential. */
  authFilePath(): string;
  /** Reads a credential already selected for the current API origin. */
  readCredential(): Promise<CliCredentialBundleV1 | null>;
  /** Atomically persists a credential. */
  writeCredential(credential: CliCredentialBundleV1): Promise<void>;
  /** Removes the local credential file. */
  clearCredential(): Promise<void>;
  /** Opens the browser verification URI. */
  openBrowser(url: string): Promise<void>;
  /** Waits between device-code polls. */
  sleep(milliseconds: number): Promise<void>;
}

const credentialStatus = (credential: CliCredentialBundleV1 | null) =>
  credential
    ? {
        authenticated: true,
        baseUrl: credential.baseUrl,
        accountId: credential.accountId,
        credentialId: credential.credentialId,
        accessExpiresAt: credential.accessExpiresAt,
        credentialExpiresAt: credential.credentialExpiresAt,
        accessExpired: credential.accessExpiresAt <= Date.now(),
      }
    : { authenticated: false };

const requireResponse = <T>(value: T | null, message: string): T => {
  if (value === null) throw new Error(message);
  return value;
};

const createDeviceCredential = async (
  dependencies: AuthCommandDependencies,
  keyPair: CliDeviceKeyPair,
  deviceCode: string,
  expiresAt: number,
  interval: number,
): Promise<CliCredentialBundleV1> => {
  let nextPollAt = Date.now();
  while (Date.now() < expiresAt) {
    const wait = nextPollAt - Date.now();
    if (wait > 0) await dependencies.sleep(wait);
    const response = requireResponse(
      await dependencies.runtime.auth.poll({ deviceCode }),
      "CLI authorization polling returned no response.",
    );
    if (response.status === "expired") {
      throw new Error("CLI authorization expired before the browser approved it.");
    }
    if (response.status === "approved") {
      const credential = await decryptCliCredentialEnvelope(
        response.envelope,
        keyPair.privateKey,
      );
      if (!isCliCredentialForBaseUrl(credential, dependencies.baseUrl())) {
        throw new Error("CLI credential was issued for a different API origin.");
      }
      return credential;
    }
    nextPollAt = Date.now() + Math.max(1, response.interval || interval) * 1000;
  }
  throw new Error("CLI authorization expired before the browser approved it.");
};

/** Creates the modular auth command. */
export const createAuthCommand = <TConfig>(
  dependencies: AuthCommandDependencies,
): CliCommand<TConfig> => ({
  name: "auth",
  async run({ args }) {
    const subcommand = args.positionals[1];
    if (subcommand === "session") {
      const accountId = flagString(args, "account");
      const proofPath = flagString(args, "proof") || "-";
      if (!accountId) throw new Error("Missing --account <id>.");
      const proof = JSON.parse(await dependencies.readInput(proofPath)) as Record<
        string,
        unknown
      >;
      const response = await dependencies.runtime.auth.session({ accountId, proof });
      dependencies.print(response);
      return;
    }

    if (subcommand === "status") {
      dependencies.print(credentialStatus(await dependencies.readCredential()));
      return;
    }

    if (subcommand === "refresh") {
      const current = await dependencies.readCredential();
      if (!current) throw new Error("No stored CLI credential. Run nd auth login first.");
      const refreshed = requireResponse(
        await dependencies.runtime.auth.refresh({ refreshToken: current.refreshToken }),
        "CLI credential refresh returned no response.",
      );
      if (!isCliCredentialForBaseUrl(refreshed, dependencies.baseUrl())) {
        throw new Error("CLI credential was issued for a different API origin.");
      }
      await dependencies.writeCredential(refreshed);
      dependencies.print(credentialStatus(refreshed));
      return;
    }

    if (subcommand === "logout") {
      const current = await dependencies.readCredential();
      let remoteRevoked = false;
      if (current) {
        try {
          await dependencies.runtime.auth.revoke({ refreshToken: current.refreshToken });
          remoteRevoked = true;
        } catch {
          remoteRevoked = false;
        } finally {
          await dependencies.clearCredential();
        }
      } else {
        await dependencies.clearCredential();
      }
      dependencies.print({ loggedOut: true, remoteRevoked });
      return;
    }

    if (subcommand === "login") {
      const keyPair = await generateCliDeviceKeyPair();
      const started = requireResponse(
        await dependencies.runtime.auth.device({
          publicKey: keyPair.publicKey,
          clientName: flagString(args, "name"),
        }),
        "CLI authorization could not start.",
      );
      const display = {
        verificationUri: started.verificationUri,
        userCode: started.userCode,
        expiresAt: started.expiresAt,
      };
      if (!hasFlag(args, "no-browser")) {
        await dependencies.openBrowser(started.verificationUri);
      }
      dependencies.print(
        display,
        `Open ${started.verificationUri} and enter ${started.userCode} to authorize this CLI.`,
      );
      const credential = await createDeviceCredential(
        dependencies,
        keyPair,
        started.deviceCode,
        started.expiresAt,
        started.interval,
      );
      await dependencies.writeCredential(credential);
      dependencies.print(credentialStatus(credential));
      return;
    }

    throw new Error(
      "Usage: nd auth login [--no-browser] [--name <name>] | status | refresh | logout | session --account <id> --proof <file|->",
    );
  },
});

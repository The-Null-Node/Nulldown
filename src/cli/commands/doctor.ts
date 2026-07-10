import type { CliCommand } from "../core/command";

interface DoctorConfig {
  baseUrl: string;
  token: string | null;
  accountId: string | null;
  clientId: string | null;
  configDir: string;
  diffAuthDir: string;
  diffAuthToken: string | null;
  diffAuthTokenPath: string;
  json: boolean;
  quiet: boolean;
  verbose: boolean;
}

interface DoctorDiffAuthBundle {
  keys: unknown;
  credentials: Record<string, unknown>;
}

/** Dependencies required by the modular doctor command. */
export interface DoctorCommandDependencies {
  /** Reads the local diff-auth bundle from the active CLI config. */
  readDiffAuthBundle(config: DoctorConfig): Promise<DoctorDiffAuthBundle>;
  /** Prints the command output using the active CLI output policy. */
  print(config: DoctorConfig, value: unknown, human?: string): void;
}

/** Creates the self-contained doctor command for the CLI registry bridge. */
export const createDoctorCommand = (
  dependencies: DoctorCommandDependencies,
): CliCommand<DoctorConfig> => ({
  name: "doctor",
  async run({ config }) {
    const diffAuthBundle = await dependencies.readDiffAuthBundle(config);
    dependencies.print(config, {
      baseUrl: config.baseUrl,
      hasToken: Boolean(config.token),
      accountId: config.accountId,
      clientId: config.clientId,
      configDir: config.configDir,
      diffAuthDir: config.diffAuthDir,
      diffAuthTokenPath: config.diffAuthTokenPath,
      hasInlineDiffAuthToken: Boolean(config.diffAuthToken),
      hasDiffAuthKeys: Boolean(diffAuthBundle.keys),
      diffAuthCredentialDropIds: Object.keys(diffAuthBundle.credentials),
    });
  },
});

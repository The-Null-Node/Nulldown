import { flagString } from "../core/args";
import type { CliCommand } from "../core/command";
import type { NulldownRuntime } from "../runtime/types";

/** Dependencies used by modular auth commands. */
export interface AuthCommandDependencies {
  /** Runtime facade for auth operations. */
  runtime: NulldownRuntime;
  /** Prints command output using the active CLI output policy. */
  print(value: unknown, human?: string): void;
  /** Reads command input from a file path or stdin marker. */
  readInput(path: string | null): Promise<string>;
}

/** Creates the modular auth command. */
export const createAuthCommand = <TConfig>(
  dependencies: AuthCommandDependencies,
): CliCommand<TConfig> => ({
  name: "auth",
  async run({ args }) {
    const subcommand = args.positionals[1];
    if (subcommand !== "session") {
      throw new Error("Usage: nd auth session --account <id> --proof <file|->");
    }
    const accountId = flagString(args, "account");
    const proofPath = flagString(args, "proof") || "-";
    if (!accountId) throw new Error("Missing --account <id>.");
    const proof = JSON.parse(await dependencies.readInput(proofPath)) as Record<
      string,
      unknown
    >;
    const response = await dependencies.runtime.auth.session({ accountId, proof });
    dependencies.print(response);
  },
});

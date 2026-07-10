import type { ParsedArgs } from "./args";

/** Context passed to a modular CLI command. */
export interface CliCommandContext<TConfig> {
  /** Resolved CLI configuration for this invocation. */
  config: TConfig;
  /** Parsed CLI arguments for this invocation. */
  args: ParsedArgs;
}

/** Modular CLI command definition used by the registry bridge. */
export interface CliCommand<TConfig> {
  /** Primary command name. */
  name: string;
  /** Optional aliases accepted by the registry. */
  aliases?: readonly string[];
  /** Optional predicate for commands that only own a subset of arguments. */
  supports?: (args: ParsedArgs) => boolean;
  /** Executes the command. */
  run(context: CliCommandContext<TConfig>): Promise<void>;
}

/** Finds a command by primary name or alias. */
export const findCliCommand = <TConfig>(
  commands: readonly CliCommand<TConfig>[],
  name: string,
  args: ParsedArgs,
): CliCommand<TConfig> | undefined =>
  commands.find(
    (command) =>
      (command.name === name || command.aliases?.includes(name)) &&
      (command.supports?.(args) ?? true),
  );

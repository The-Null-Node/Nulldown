/** Parsed CLI positional arguments and flags. */
export interface ParsedArgs {
  /** Positional arguments in the order supplied by the user. */
  positionals: string[];
  /** Parsed long flags, where bare flags are represented as true. */
  flags: Record<string, string | boolean>;
}

/** Parses argv into positionals and long-form flags. */
export const parseArgs = (argv: string[]): ParsedArgs => {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index];
    if (entry === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }

    if (!entry.startsWith("--")) {
      positionals.push(entry);
      continue;
    }

    const raw = entry.slice(2);
    const equalIndex = raw.indexOf("=");
    if (equalIndex !== -1) {
      flags[raw.slice(0, equalIndex)] = raw.slice(equalIndex + 1);
      continue;
    }

    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      flags[raw] = next;
      index += 1;
      continue;
    }

    flags[raw] = true;
  }

  return { positionals, flags };
};

/** Returns a flag value only when it was supplied as a string. */
export const flagString = (args: ParsedArgs, name: string): string | null => {
  const value = args.flags[name];
  return typeof value === "string" ? value : null;
};

/** Returns true when a bare long-form flag was supplied. */
export const hasFlag = (args: ParsedArgs, name: string): boolean =>
  args.flags[name] === true;

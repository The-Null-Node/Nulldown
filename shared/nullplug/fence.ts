const NULLPLUG_ID_PATTERN = /^[a-z0-9._:-]+$/i;
const LEGACY_NULLPLUG_PATTERN =
  /^plugin\(\s*(["'])([a-z0-9._:-]+)\1\s*\)$/i;

/** Syntax form used to express a potential Nullplug invocation in a fence. */
export type NullplugFenceInvocationForm = "bare" | "call" | "legacy";

/** Parsed invocation candidate from a fenced-code info string. */
export interface NullplugFenceInvocation {
  /** Normalized Nullplug id. */
  id: string;
  /** Raw call arguments, when supplied. */
  args: string | null;
  /** Whether the author used bare, call, or legacy plugin syntax. */
  form: NullplugFenceInvocationForm;
}

const normalizeNullplugId = (id: string): string => id.trim().toLowerCase();

/** Parses a conservative fenced-code info string as a Nullplug candidate. */
export const parseNullplugFenceInvocation = (
  info: string,
): NullplugFenceInvocation | null => {
  const trimmed = info.trim();
  if (!trimmed) return null;

  const legacyMatch = LEGACY_NULLPLUG_PATTERN.exec(trimmed);
  if (legacyMatch?.[2]) {
    return {
      id: normalizeNullplugId(legacyMatch[2]),
      args: null,
      form: "legacy",
    };
  }

  if (NULLPLUG_ID_PATTERN.test(trimmed)) {
    return {
      id: normalizeNullplugId(trimmed),
      args: null,
      form: "bare",
    };
  }

  const openParen = trimmed.indexOf("(");
  if (openParen <= 0 || !trimmed.endsWith(")")) return null;

  const id = trimmed.slice(0, openParen).trim();
  if (!NULLPLUG_ID_PATTERN.test(id)) return null;

  const args = trimmed.slice(openParen + 1, -1).trim();
  return {
    id: normalizeNullplugId(id),
    args: args || null,
    form: "call",
  };
};

/** Returns true when authored syntax explicitly requests Nullplug resolution. */
export const isExplicitNullplugFenceInvocation = (
  invocation: NullplugFenceInvocation,
): boolean => invocation.form !== "bare";

const NATIVE_BARE_NULLPLUG_IDS = new Set([
  "approval",
  "embed",
  "graph",
  "nd",
]);

/** Classifies source-only refs without consulting a mutable provider registry. */
export const isSourceNullplugFenceInvocation = (
  invocation: NullplugFenceInvocation,
): boolean =>
  isExplicitNullplugFenceInvocation(invocation) ||
  NATIVE_BARE_NULLPLUG_IDS.has(invocation.id);

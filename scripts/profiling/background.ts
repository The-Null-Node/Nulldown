/** Local fixture attribution only; not an application deadline or runtime hook. */
export function backgroundKind(
  stack: string,
): "profile-export" | "legacy-export" | "snapshotter" | "other" {
  const caller = stack.split("\n")[2] ?? "";
  if (caller.includes("at Object.finish (")) return "profile-export";
  if (caller.includes("at scheduleBufferedCommitFlush (")) return "snapshotter";
  if (caller.includes("at onRequest (")) return "legacy-export";
  return "other";
}
export function exportsWithinDeadline(tasks: { kind: string; ms: number }[]) {
  return tasks
    .filter((t) => t.kind === "profile-export" || t.kind === "legacy-export")
    .every((t) => t.ms <= 650);
}

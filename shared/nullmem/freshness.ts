import type {
  NullMemCapsule,
  NullMemFactRecord,
  NullMemFreshnessInput,
  NullMemFreshnessOptions,
  NullMemFreshnessQueryResult,
  NullMemFreshnessReport,
  NullMemFreshnessResult,
  NullMemFreshnessStatus,
  NullMemRecord,
} from "./types";

/** Extracts explicit superseding record ids from a record's labels. */
export const extractSupersedesFromLabels = (labels?: string[]): string[] =>
  (labels ?? [])
    .filter((label) => label.startsWith("supersedes:"))
    .map((label) => label.slice("supersedes:".length))
    .filter(Boolean);

/** Returns true when a record carries an explicit stale marker. */
export const hasStaleMemoryLabel = (record: NullMemRecord): boolean =>
  (record.labels ?? []).includes("stale-memory");

/** Collects snapshot ids referenced by a record's source refs. */
export const collectSnapshotSourceIds = (record: NullMemRecord): number[] => {
  const refs = record.sourceRefs ?? [];
  const ids: number[] = [];
  for (const ref of refs) {
    if (ref.kind === "snapshot" && typeof ref.snapshotId === "number") {
      ids.push(ref.snapshotId);
    }
    if (ref.kind === "heap" && typeof ref.snapshotId === "number") {
      ids.push(ref.snapshotId);
    }
  }
  return ids;
};

/** Evaluates freshness for a single record against the provided context. */
export const evaluateNullMemFreshness = (
  record: NullMemRecord,
  options: NullMemFreshnessOptions = {},
): NullMemFreshnessReport => {
  const hasStale = hasStaleMemoryLabel(record);
  const superseded = extractSupersedesFromLabels(record.labels);
  const snapshotRefs = collectSnapshotSourceIds(record);
  const current = options.currentSnapshotId;
  const heads = options.snapshotHeads ?? {};
  const knownSupersedes = new Set(options.knownSupersedingIds ?? []);

  const outdated: number[] = [];
  for (const sid of snapshotRefs) {
    let head: number | undefined = current;
    if (!head) {
      // Try to resolve from per-branch heads using the first matching source ref.
      const matchingRef = (record.sourceRefs ?? []).find(
        (ref) =>
          (ref.kind === "snapshot" || ref.kind === "heap") &&
          typeof ref.snapshotId === "number" &&
          ref.snapshotId === sid,
      ) as
        | { kind: "snapshot" | "heap"; rootDropId: string; branchId: string; snapshotId: number }
        | undefined;
      if (matchingRef) {
        const key = `${matchingRef.rootDropId}:${matchingRef.branchId}`;
        head = heads[key];
      }
    }
    if (typeof head === "number" && sid < head) {
      outdated.push(sid);
    }
  }

  const hasAnySource =
    (record.sourceRefs ?? []).length > 0 ||
    snapshotRefs.length > 0 ||
    (record as NullMemFactRecord).targetKind !== undefined ||
    (record as NullMemFactRecord).targetId !== undefined;

  let status: NullMemFreshnessStatus;
  let reason: string;

  if (hasStale) {
    status = "explicit-stale";
    reason = "Record carries an explicit stale-memory label.";
  } else if (superseded.length > 0 || superseded.some((id) => knownSupersedes.has(id))) {
    status = "superseded";
    reason = `Record is superseded by ${superseded.join(", ") || "a later record"}.`;
  } else if (outdated.length > 0) {
    status = "snapshot-outdated";
    reason = `Record cites snapshot(s) ${outdated.join(", ")} older than current head ${current ?? "?"}.`;
  } else if (!hasAnySource) {
    status = "source-missing";
    reason = "Record has no source refs or target identifiers to evaluate against.";
  } else if (typeof current !== "number" && Object.keys(heads).length === 0) {
    status = "unverifiable";
    reason = "No current snapshot head was provided; freshness cannot be verified.";
  } else {
    status = "fresh";
    reason = "Record sources are at or ahead of the current snapshot heads.";
  }

  if (
    status === "fresh" &&
    (record.labels ?? []).some((l) => l === "needs-review")
  ) {
    status = "needs-review";
    reason = "Record is marked for review even though sources appear current.";
  }

  return {
    recordId: record.recordId,
    status,
    reason,
    currentSnapshotId: current,
    outdatedSnapshotRefs: outdated.length ? outdated : undefined,
    supersededBy: superseded.length ? superseded : undefined,
    hasStaleLabel: hasStale,
    hasSourceRefs: hasAnySource,
  };
};

/** Evaluates freshness for a batch of records. */
export const evaluateNullMemFreshnessBatch = (
  input: NullMemFreshnessInput,
): NullMemFreshnessResult => {
  const reports: NullMemFreshnessReport[] = input.records.map((record) =>
    evaluateNullMemFreshness(record, {
      currentSnapshotId: input.currentSnapshotId,
      snapshotHeads: input.snapshotHeads,
      knownSupersedingIds: input.knownSupersedingIds,
    }),
  );
  const byRecordId: Record<string, NullMemFreshnessReport> = {};
  for (const report of reports) {
    byRecordId[report.recordId] = report;
  }
  return { reports, byRecordId };
};

/** Filters records to only those whose freshness status is not fresh. */
export const filterStaleRecords = (
  records: NullMemRecord[],
  result: NullMemFreshnessResult,
): NullMemRecord[] =>
  records.filter((record) => {
    const report = result.byRecordId[record.recordId];
    return !report || report.status !== "fresh";
  });

/** Converts a freshness report into a compact human summary. */
export const formatNullMemFreshnessSummary = (
  report: NullMemFreshnessReport,
): string =>
  `${report.recordId} [${report.status}] ${report.reason}`;

/** Converts a freshness query result into a CLI-friendly object. */
export const nullMemFreshnessToCli = (result: NullMemFreshnessQueryResult) => ({
  rootDropId: result.rootDropId,
  branchId: result.branchId,
  query: result.query,
  reports: result.reports.map((r) => ({
    recordId: r.recordId,
    status: r.status,
    reason: r.reason,
    currentSnapshotId: r.currentSnapshotId,
    outdated: r.outdatedSnapshotRefs,
    supersededBy: r.supersededBy,
  })),
  count: result.reports.length,
  staleCount: result.reports.filter((r) => r.status !== "fresh").length,
});

/** Converts a freshness query result into a compact capsule list for agents. */
export const nullMemFreshnessToCapsules = (
  result: NullMemFreshnessQueryResult,
): NullMemCapsule[] => result.capsules ?? [];

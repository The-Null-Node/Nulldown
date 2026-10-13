import type { Diff } from "../nulledit/types";
import {
  DiffRangeSchema,
  DropDiffNativeOpSchema,
  DropDiffOpSchema,
  diffToDropDiffOpV1,
  dropDiffOpV1ToDiff,
} from "./codecs/diff-v1";
import type { DropDiffOp } from "./diff";

const copyRecord = (record: DropDiffOp): DropDiffOp => ({
  ...record,
  ...(record.native
    ? {
        native: {
          ...record.native,
          ...(record.native.range ? { range: { ...record.native.range } } : {}),
        },
      }
    : {}),
});

/**
 * Immutable, runtime-owned branch operation with v1 editor/record conversion.
 *
 * Each instance owns its operation independently of caller buffers and ranges.
 * Only `toRecord()` results belong in persistence or transport; methods stay in
 * the runtime. Editor attributes are omitted, as in the v1 codec, rather than
 * retaining references to arbitrary caller-owned metadata.
 */
export class DropDiffOperation {
  readonly #record: DropDiffOp;

  private constructor(record: DropDiffOp) {
    this.#record = record;
  }

  /**
   * Captures a validated editor operation for this runtime lifetime.
   * Throws for invalid operation codes, ranges, or non-ArrayBuffer payloads.
   * Uses the codec's default range and legacy projection, including empty data.
   * Record size limits remain a transport concern: the v1 record reader rejects
   * empty native data even though the editor codec emits it for empty payloads.
   */
  static fromDiff(diff: Diff): DropDiffOperation {
    if (!diff || !(diff.data instanceof ArrayBuffer)) {
      throw new TypeError("Diff data must be an ArrayBuffer.");
    }
    const op = DropDiffNativeOpSchema.shape.op.parse(diff.op);
    const range =
      diff.range === undefined ? undefined : DiffRangeSchema.parse(diff.range);
    return new DropDiffOperation(
      diffToDropDiffOpV1({ op, data: diff.data.slice(0), range }),
    );
  }

  /**
   * Validates and captures an untrusted persisted/transport v1 record.
   * Throws on schema-invalid or undecodable native data before creating a value.
   * Retains the supplied legacy/native forms without normalizing stored history.
   */
  static fromRecord(record: unknown): DropDiffOperation {
    const parsed = DropDiffOpSchema.parse(record);
    // Validate decoding as well: the schema's base64 shape check is permissive.
    if (!dropDiffOpV1ToDiff(parsed)) {
      throw new TypeError("Diff operation cannot be decoded.");
    }
    return new DropDiffOperation(parsed);
  }

  /** Returns an independent plain v1 record for persistence or transport. */
  toRecord(): DropDiffOp {
    return copyRecord(this.#record);
  }

  /**
   * Returns a fresh editor operation, buffer, and range for runtime use.
   * Native data is authoritative; absent native ranges default to zero.
   * Attributes are not part of the v1 branch operation contract.
   */
  toDiff(): Diff {
    const diff = dropDiffOpV1ToDiff(this.toRecord());
    if (!diff) throw new TypeError("Diff operation cannot be decoded.");
    return diff;
  }
}

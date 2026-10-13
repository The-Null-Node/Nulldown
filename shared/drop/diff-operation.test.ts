import { DiffOp, type Diff } from "../nulledit/types";
import { encodeText } from "../nulledit/textDiff";
import { diffToDropDiffOp, dropDiffOpToDiff, type DropDiffOp } from "./diff";
import { DropDiffOperation } from "./diff-operation";

describe("DropDiffOperation", () => {
  it.each([DiffOp.INSERT, DiffOp.DELETE, DiffOp.RETAIN])(
    "preserves native bytes and the legacy projection for operation %s",
    (op) => {
      const diff: Diff = {
        op,
        data: new Uint8Array([0, 255, 16]).buffer,
        range: { start: 2, end: 5 },
      };
      const operation = DropDiffOperation.fromDiff(diff);
      expect(operation.toRecord()).toEqual(diffToDropDiffOp(diff));
      expect(operation.toDiff()).toEqual(diff);
      expect(
        DropDiffOperation.fromRecord(operation.toRecord()).toDiff(),
      ).toEqual(diff);
    },
  );

  const records: DropDiffOp[] = [
    { type: "insert", start: 1, end: 1, text: "🙂 café" },
    { type: "delete", start: 1, end: 8, text: "" },
    { native: { op: DiffOp.RETAIN, data: "AP8Q" } },
    {
      type: "insert",
      start: 8,
      end: 8,
      text: "ignored",
      native: { op: DiffOp.DELETE, data: "AP8Q", range: { start: 2, end: 5 } },
    },
    { start: 9, native: { op: DiffOp.INSERT, data: "YQ==" } },
    {
      type: "insert",
      start: Number.MAX_SAFE_INTEGER + 1,
      end: Number.MAX_SAFE_INTEGER + 1,
      text: "history",
    },
  ];

  it.each(records)("preserves supported v1 history %j", (record) => {
    const operation = DropDiffOperation.fromRecord(record);
    expect(operation.toRecord()).toEqual(record);
    expect(operation.toDiff()).toEqual(dropDiffOpToDiff(record));
    expect(JSON.parse(JSON.stringify(operation.toRecord()))).toEqual(record);
    expect(Object.getPrototypeOf(operation.toRecord())).toBe(Object.prototype);
  });

  it("preserves empty editor payloads and default ranges without weakening the record schema", () => {
    const diff: Diff = { op: DiffOp.DELETE, data: new ArrayBuffer(0) };
    const operation = DropDiffOperation.fromDiff(diff);
    expect(operation.toRecord()).toEqual(diffToDropDiffOp(diff));
    expect(operation.toDiff()).toEqual({
      ...diff,
      range: { start: 0, end: 0 },
    });
    expect(() => DropDiffOperation.fromRecord(operation.toRecord())).toThrow();
  });

  it.each([
    null,
    {},
    { type: "insert", start: 0, end: 0 },
    { type: "delete", start: 2, end: 1, text: "" },
    { type: "insert", start: -1, end: 0, text: "a" },
    { type: "insert", start: 0.5, end: 1, text: "a" },
    { native: { op: 3, data: "YQ==" } },
    { native: { op: 0, data: "!" } },
    { native: { op: 0, data: "A===" } },
    { native: { op: 0, data: "YQ==", range: { start: 1, end: 0 } } },
    { native: { op: 0, data: "YQ==" }, extra: true },
  ])("rejects invalid records %j", (record) => {
    expect(() => DropDiffOperation.fromRecord(record)).toThrow();
  });

  it.each([
    null,
    { op: 3, data: encodeText("a") },
    { op: 0, data: new Uint8Array([1]) },
    { op: 0, data: encodeText("a"), range: { start: 2, end: 1 } },
    { op: 0, data: encodeText("a"), range: { start: NaN, end: 1 } },
  ])("rejects invalid editor operations", (diff) => {
    expect(() => DropDiffOperation.fromDiff(diff as Diff)).toThrow();
  });

  it("isolates editor buffers and ranges and omits arbitrary attributes like v1", () => {
    const attributes = { nested: { label: "before" }, callback: () => true };
    const diff: Diff = {
      op: DiffOp.INSERT,
      data: encodeText("abc"),
      range: { start: 1, end: 1 },
      attributes,
    };
    const expected: Diff = {
      op: DiffOp.INSERT,
      data: encodeText("abc"),
      range: { start: 1, end: 1 },
    };
    const operation = DropDiffOperation.fromDiff(diff);
    new Uint8Array(diff.data).fill(0);
    diff.range!.start = 100;
    attributes.nested.label = "after";
    const output = operation.toDiff();
    new Uint8Array(output.data).fill(255);
    output.range!.end = 100;
    expect(operation.toDiff()).toEqual(expected);
    expect(operation.toDiff().attributes).toBeUndefined();
  });

  it("isolates input records, output records, and decoded ranges", () => {
    const record: DropDiffOp = {
      native: { op: DiffOp.INSERT, data: "YQ==", range: { start: 1, end: 1 } },
    };
    const operation = DropDiffOperation.fromRecord(record);
    const expected = operation.toRecord();
    record.native!.range!.start = 100;
    record.native!.data = "Yg==";
    const output = operation.toRecord();
    output.native!.range!.end = 100;
    output.native!.op = DiffOp.DELETE;
    operation.toDiff().range!.start = 100;
    expect(operation.toRecord()).toEqual(expected);
    expect(operation.toDiff()).toEqual(dropDiffOpToDiff(expected));
  });
});

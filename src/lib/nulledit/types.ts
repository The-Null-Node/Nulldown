type Op = "insert" | "delete" | "retain";

interface Range {
  start: number;
  end: number;
}

export interface Diff {
  op: Op;
  data: ArrayBuffer;
  attributes?: Record<string, any>;
  range?: Range;
}

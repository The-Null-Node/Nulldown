export type DropDiffOpType = "insert" | "delete";

export interface DropDiffOp {
  type: DropDiffOpType;
  start: number;
  end: number;
  text: string;
}

export interface DropDiffEvent {
  eventId: string;
  seq: number;
  dropId: string;
  sourceClientId: string;
  createdAt: number;
  snapshotId?: number;
  ops: DropDiffOp[];
}

export interface DropDiffEnvelope {
  version: 1;
  events: DropDiffEvent[];
}

export interface DropDiffPollResponse {
  events: DropDiffEvent[];
  cursor: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isString = (value: unknown): value is string => typeof value === "string";

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

export const isDropDiffOp = (value: unknown): value is DropDiffOp => {
  if (!isRecord(value)) return false;
  if (value.type !== "insert" && value.type !== "delete") return false;
  return isNumber(value.start) && isNumber(value.end) && isString(value.text);
};

export const isDropDiffEvent = (value: unknown): value is DropDiffEvent => {
  if (!isRecord(value)) return false;
  if (!isString(value.eventId)) return false;
  if (!isNumber(value.seq)) return false;
  if (!isString(value.dropId)) return false;
  if (!isString(value.sourceClientId)) return false;
  if (!isNumber(value.createdAt)) return false;
  if (value.snapshotId !== undefined && !isNumber(value.snapshotId)) return false;
  if (!Array.isArray(value.ops)) return false;
  return value.ops.every((op) => isDropDiffOp(op));
};

export const isDropDiffEnvelope = (
  value: unknown,
): value is DropDiffEnvelope => {
  if (!isRecord(value)) return false;
  if (value.version !== 1) return false;
  if (!Array.isArray(value.events)) return false;
  return value.events.every((event) => isDropDiffEvent(event));
};

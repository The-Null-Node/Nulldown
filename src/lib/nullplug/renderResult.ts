import type { JsonValue, NullplugResult } from "../../../shared/nullplug/types";
import type { NullplugUiPrimitive } from "../../../shared/nullplug/ui";
import type { PluginBlock, RenderableDiff, RenderablePatch } from "./types";

const uniqueStrings = (values: Iterable<string | undefined>): string[] => [
  ...new Set([...values].filter((value): value is string => Boolean(value))),
];

const primitiveCallIds = (
  primitive: NullplugUiPrimitive,
): (string | undefined)[] => [
  primitive.source?.callId,
  ...(primitive.kind === "card"
    ? (primitive.actions ?? []).map((action) => action.source?.callId)
    : []),
];

/** Collects semantic call ids referenced by one normalized result. */
export const collectRenderCallIds = (result: NullplugResult): string[] =>
  uniqueStrings([
    ...(result.uiPrimitives ?? []).flatMap(primitiveCallIds),
    ...(result.mutations ?? []).map((mutation) =>
      mutation.kind === "ui.state.patch" ? mutation.callId : undefined,
    ),
    ...(result.yields ?? []).map((yielded) => {
      const callId = yielded.metadata?.callId;
      return typeof callId === "string" ? callId : undefined;
    }),
  ]);

const isJsonRecord = (
  value: JsonValue | undefined,
): value is Record<string, JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Merges invocation state under its semantic call ids without losing prior state. */
export const mergeRenderInvocationUiState = (
  target: Record<string, JsonValue>,
  source: Record<string, JsonValue>,
  callIds: readonly string[],
): void => {
  if (!callIds.length) {
    Object.assign(target, source);
    return;
  }
  callIds.forEach((callId) => {
    target[callId] = {
      ...(isJsonRecord(target[callId]) ? target[callId] : {}),
      ...source,
    };
  });
};

/** Converts a handler replacement into a source-addressed render diff. */
export const toRenderableDiff = (
  block: PluginBlock,
  patch: RenderablePatch | null,
): RenderableDiff | null => {
  if (!patch) return null;
  if (
    typeof (patch as RenderableDiff).start === "number" &&
    typeof (patch as RenderableDiff).end === "number"
  ) {
    const diff = patch as RenderableDiff;
    return { start: diff.start, end: diff.end, text: diff.text };
  }
  return { start: block.start, end: block.end, text: patch.text };
};

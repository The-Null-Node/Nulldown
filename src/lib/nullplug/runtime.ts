import {
  isNullplugInvokeResponse,
  isNullplugResult,
  type NullplugDiagnostic,
  type NullplugResult,
} from "../../../shared/nullplug/types";
import {
  filterNullplugInvokeResponse,
  type NullplugResultPolicyOptions,
} from "../../../shared/nullplug/resultPolicy";
import type { PluginBlock, RenderableDiff, RenderablePatch } from "./types";

export interface NormalizedNullplugRuntimeResult {
  result: NullplugResult;
  patch: RenderablePatch | null;
  diagnostics: NullplugDiagnostic[];
}

export type NullplugRuntimePolicyOptions = NullplugResultPolicyOptions;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isRenderableDiff = (value: unknown): value is RenderableDiff =>
  isRecord(value) &&
  typeof value.start === "number" &&
  typeof value.end === "number" &&
  typeof value.text === "string";

const isRenderablePatch = (value: unknown): value is RenderablePatch =>
  isRenderableDiff(value) ||
  (isRecord(value) &&
    typeof value.text === "string" &&
    value.start === undefined &&
    value.end === undefined);

const resultContentToPatch = (
  result: NullplugResult,
  _block: PluginBlock,
): RenderablePatch | null => {
  if (typeof result.content !== "string") {
    return null;
  }

  return { text: result.content };
};

export const validateNullplugRuntimeResult = (
  normalized: NormalizedNullplugRuntimeResult,
  options: NullplugRuntimePolicyOptions = {},
): NormalizedNullplugRuntimeResult => {
  const validated = filterNullplugInvokeResponse(
    { result: normalized.result, diagnostics: normalized.diagnostics },
    options,
  );

  return {
    result: validated.result,
    patch: validated.result.content === undefined ? null : normalized.patch,
    diagnostics: validated.diagnostics ?? [],
  };
};

export const normalizeNullplugRuntimeReturn = (
  value: unknown,
  block: PluginBlock,
  options: NullplugRuntimePolicyOptions = {},
): NormalizedNullplugRuntimeResult | null => {
  let normalized: NormalizedNullplugRuntimeResult | null = null;

  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string") {
    normalized = {
      result: { content: value },
      patch: { text: value },
      diagnostics: [],
    };
  } else if (isNullplugInvokeResponse(value)) {
    normalized = {
      result: value.result,
      patch: resultContentToPatch(value.result, block),
      diagnostics: value.diagnostics ?? [],
    };
  } else if (isNullplugResult(value)) {
    normalized = {
      result: value,
      patch: resultContentToPatch(value, block),
      diagnostics: [],
    };
  } else if (isRenderablePatch(value)) {
    normalized = {
      result: { content: value.text },
      patch: value,
      diagnostics: [],
    };
  }

  return normalized ? validateNullplugRuntimeResult(normalized, options) : null;
};

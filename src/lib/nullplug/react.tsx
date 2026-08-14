import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import { useStoreWithEqualityFn } from "zustand/traditional";
import useEditorStore from "../../stores/editorStore";
import type {
  JsonValue,
  NullplugMutation,
} from "../../../shared/nullplug/types";
import type {
  DropRuntimeNullplugCallProvenance,
} from "../../../shared/drop/runtime";
import type {
  NullplugActionPrimitive,
  NullplugCardPrimitive,
  NullplugFormPrimitive,
  NullplugUiField,
  NullplugUiPrimitive,
  NullplugUiResponseFact,
  NullplugUiSource,
  NullplugUiStatePatchFact,
  NullplugUiStatePatchOperation,
} from "../../../shared/nullplug/ui";
import {
  areNullplugRuntimeSelectionsEqual,
  selectNullplugProviderStatuses,
  selectNullplugRuntime,
  selectNullplugStatePath,
  type NullplugProviderStatus,
  type NullplugRenderStatus,
  type NullplugRuntimeSelection,
  type NullplugStatePathOptions,
} from "./reactRuntime";

export interface NullplugProviderRuntime {
  submitResponse?: (fact: NullplugUiResponseFact) => Promise<void>;
  patchState?: (fact: NullplugUiStatePatchFact) => Promise<void>;
  applyMutation?: (
    mutation: NullplugMutation,
    refs: NullplugRuntimeSelection["refs"],
  ) => Promise<void>;
}

export interface NullplugProviderProps extends NullplugProviderRuntime {
  children: React.ReactNode;
}

export interface UseNullplugOptions {
  callId?: string;
}

export interface UseNullplugResult extends NullplugRuntimeSelection {
  canSubmit: boolean;
  submitResponse: (
    data: Record<string, JsonValue>,
    primitive?: Pick<NullplugUiPrimitive, "id" | "source">,
  ) => Promise<void>;
  patchState: (
    patch: NullplugUiStatePatchOperation[],
    reason?: string,
  ) => Promise<void>;
  applyMutation: (mutation: NullplugMutation) => Promise<void>;
}

const NullplugRuntimeContext = createContext<NullplugProviderRuntime>({});

const createFactId = (prefix: string): string => {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

const createSource = (
  refs: NullplugRuntimeSelection["refs"],
  primitive?: Pick<NullplugUiPrimitive, "source">,
): NullplugUiSource => {
  const rootDropId = primitive?.source?.rootDropId ?? refs.rootDropId;
  if (!rootDropId) {
    throw new Error("Nullplug response requires a root drop id.");
  }

  return {
    rootDropId,
    branchId: primitive?.source?.branchId ?? refs.branchId,
    snapshotId: primitive?.source
      ? primitive.source.snapshotId
      : refs.versionId,
    sourceContentHash: refs.sourceContentHash,
    eventId: primitive?.source?.eventId,
    callId: primitive?.source?.callId ?? refs.callId,
  };
};

export const NullplugProvider: React.FC<NullplugProviderProps> = ({
  children,
  submitResponse,
  patchState,
  applyMutation,
}) => {
  const runtime = useMemo(
    () => ({ submitResponse, patchState, applyMutation }),
    [applyMutation, patchState, submitResponse],
  );
  return (
    <NullplugRuntimeContext.Provider value={runtime}>
      {children}
    </NullplugRuntimeContext.Provider>
  );
};

/** Subscribes to exactly one call-scoped JSON state path. */
export const useNullplugPath = (
  options: NullplugStatePathOptions,
): JsonValue | undefined =>
  useStoreWithEqualityFn(
    useEditorStore,
    (state) => selectNullplugStatePath(state.nullplugRenderState, options),
    Object.is,
  );

export const useNullplug = (
  options: UseNullplugOptions = {},
): UseNullplugResult => {
  const runtime = useContext(NullplugRuntimeContext);
  const [actionStatus, setActionStatus] = useState<NullplugRenderStatus | null>(
    null,
  );
  const selection = useStoreWithEqualityFn(
    useEditorStore,
    (state) =>
      selectNullplugRuntime(
        state.nullplugRenderState,
        state.renderFrame,
        options,
      ),
    areNullplugRuntimeSelectionsEqual,
  );

  const submitResponse = useCallback<UseNullplugResult["submitResponse"]>(
    async (data, primitive) => {
      if (!runtime.submitResponse) {
        throw new Error("No nullplug response runtime is configured.");
      }

      const fact: NullplugUiResponseFact = {
        version: 1,
        kind: "ui.response",
        id: createFactId("response"),
        primitiveId: primitive?.id ?? selection.callId,
        createdAt: Date.now(),
        source: createSource(selection.refs, primitive),
        data,
      };

      setActionStatus("submitting");
      try {
        await runtime.submitResponse(fact);
      } finally {
        setActionStatus(null);
      }
    },
    [runtime, selection.callId, selection.refs],
  );

  const patchState = useCallback<UseNullplugResult["patchState"]>(
    async (patch, reason) => {
      if (!runtime.patchState) {
        throw new Error("No nullplug state runtime is configured.");
      }

      const fact: NullplugUiStatePatchFact = {
        version: 1,
        kind: "ui.state.patch",
        id: createFactId("patch"),
        callId: selection.callId,
        createdAt: Date.now(),
        source: createSource(selection.refs),
        patch,
        reason,
      };

      setActionStatus("submitting");
      try {
        await runtime.patchState(fact);
      } finally {
        setActionStatus(null);
      }
    },
    [runtime, selection.callId, selection.refs],
  );

  const applyMutation = useCallback<UseNullplugResult["applyMutation"]>(
    async (mutation) => {
      if (!runtime.applyMutation) {
        throw new Error("No nullplug mutation runtime is configured.");
      }

      setActionStatus("submitting");
      try {
        await runtime.applyMutation(mutation, selection.refs);
      } finally {
        setActionStatus(null);
      }
    },
    [runtime, selection.refs],
  );

  return {
    ...selection,
    status: actionStatus ?? selection.status,
    canSubmit: Boolean(runtime.submitResponse && selection.refs.rootDropId),
    submitResponse,
    patchState,
    applyMutation,
  };
};

const fieldDefaultValue = (field: NullplugUiField): JsonValue => {
  if (field.defaultValue !== undefined) return field.defaultValue;
  if (field.type === "boolean") return false;
  if (field.type === "number") return 0;
  return "";
};

const formInitialData = (
  primitive: NullplugFormPrimitive,
): Record<string, JsonValue> =>
  Object.fromEntries(
    primitive.fields.map((field) => [field.name, fieldDefaultValue(field)]),
  ) as Record<string, JsonValue>;

const jsonToInputValue = (value: JsonValue | undefined): string =>
  typeof value === "string" || typeof value === "number" ? String(value) : "";

export const NullplugAction: React.FC<{
  primitive: NullplugActionPrimitive;
}> = ({ primitive }) => {
  const nullplug = useNullplug({ callId: primitive.source?.callId });
  const disabled = !nullplug.canSubmit || nullplug.status === "submitting";

  return (
    <button
      type="button"
      disabled={disabled}
      title={
        disabled ? "Nullplug runtime submission is not configured." : undefined
      }
      onClick={() => {
        void nullplug.submitResponse(
          {
            action: primitive.id,
            ...(primitive.intent ? { intent: primitive.intent } : {}),
            ...(primitive.value !== undefined
              ? { value: primitive.value }
              : {}),
          },
          primitive,
        );
      }}
      className="inline-flex items-center rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
    >
      {primitive.label}
    </button>
  );
};

export const NullplugForm: React.FC<{ primitive: NullplugFormPrimitive }> = ({
  primitive,
}) => {
  const nullplug = useNullplug({ callId: primitive.source?.callId });
  const [data, setData] = useState<Record<string, JsonValue>>(() =>
    formInitialData(primitive),
  );
  const [submissionState, setSubmissionState] = useState<
    "idle" | "submitted" | "error"
  >("idle");
  const disabled =
    !nullplug.canSubmit ||
    nullplug.status === "submitting" ||
    submissionState === "submitted";

  return (
    <form
      className="space-y-3 rounded-lg border border-border bg-background/70 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        setSubmissionState("idle");
        void nullplug
          .submitResponse(data, primitive)
          .then(() => setSubmissionState("submitted"))
          .catch(() => setSubmissionState("error"));
      }}
    >
      {primitive.title ? (
        <div className="text-sm font-medium text-foreground">
          {primitive.title}
        </div>
      ) : null}
      {primitive.description ? (
        <p className="text-xs text-muted-foreground">{primitive.description}</p>
      ) : null}

      {primitive.fields.map((field) => {
        const value = data[field.name];
        const commonProps = {
          id: `${primitive.id}-${field.name}`,
          name: field.name,
          required: field.required,
          disabled,
          className:
            "min-h-8 rounded-md border border-input bg-background px-2 py-1 text-sm text-foreground disabled:opacity-50",
        };

        return (
          <label
            key={field.name}
            className="grid gap-1 text-xs text-muted-foreground"
          >
            <span>{field.label ?? field.name}</span>
            {field.type === "textarea" ? (
              <textarea
                {...commonProps}
                value={jsonToInputValue(value)}
                onChange={(event) =>
                  setData((current) => ({
                    ...current,
                    [field.name]: event.target.value,
                  }))
                }
              />
            ) : field.type === "boolean" ? (
              <input
                {...commonProps}
                type="checkbox"
                checked={value === true}
                onChange={(event) =>
                  setData((current) => ({
                    ...current,
                    [field.name]: event.target.checked,
                  }))
                }
              />
            ) : field.type === "select" ? (
              <select
                {...commonProps}
                value={String(
                  Math.max(
                    0,
                    field.options?.findIndex(
                      (option) => option.value === value,
                    ) ?? 0,
                  ),
                )}
                onChange={(event) => {
                  const option = field.options?.[Number(event.target.value)];
                  if (!option) return;
                  setData((current) => ({
                    ...current,
                    [field.name]: option.value,
                  }));
                }}
              >
                {(field.options ?? []).map((option, index) => (
                  <option key={`${field.name}-${index}`} value={index}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                {...commonProps}
                type={field.type === "number" ? "number" : "text"}
                value={jsonToInputValue(value)}
                onChange={(event) =>
                  setData((current) => ({
                    ...current,
                    [field.name]:
                      field.type === "number"
                        ? Number(event.target.value)
                        : event.target.value,
                  }))
                }
              />
            )}
          </label>
        );
      })}

      <button
        type="submit"
        disabled={disabled}
        className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submissionState === "submitted"
          ? "Response recorded"
          : (primitive.submitLabel ?? "Submit")}
      </button>
      {submissionState === "error" ? (
        <p className="text-xs text-destructive">
          The decision could not be recorded. Check your session and try again.
        </p>
      ) : null}
    </form>
  );
};

export const NullplugCard: React.FC<{ primitive: NullplugCardPrimitive }> = ({
  primitive,
}) => (
  <section className="rounded-lg border border-border bg-background/70 p-3">
    {primitive.title ? (
      <div className="text-sm font-medium text-foreground">
        {primitive.title}
      </div>
    ) : null}
    {primitive.body ? (
      <p className="mt-1 text-sm text-muted-foreground">{primitive.body}</p>
    ) : null}
    {primitive.actions?.length ? (
      <div className="mt-3 flex flex-wrap gap-2">
        {primitive.actions.map((action) => (
          <NullplugAction key={action.id} primitive={action} />
        ))}
      </div>
    ) : null}
  </section>
);

export const NullplugPrimitive: React.FC<{
  primitive: NullplugUiPrimitive;
}> = ({ primitive }) => {
  if (primitive.kind === "form") return <NullplugForm primitive={primitive} />;
  if (primitive.kind === "action")
    return <NullplugAction primitive={primitive} />;
  return <NullplugCard primitive={primitive} />;
};

const PROVIDER_STATUS_LABELS: Record<
  NullplugProviderStatus["status"],
  string
> = {
  ready: "Ready",
  blocked: "Blocked",
  conditional: "Approval required",
  failed: "Failed",
};

const PROVIDER_STATUS_CLASSES: Record<
  NullplugProviderStatus["status"],
  string
> = {
  ready: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  blocked: "bg-destructive/10 text-destructive",
  conditional: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  failed: "bg-destructive/10 text-destructive",
};

const NullplugProviderStatusList: React.FC<{
  statuses: readonly NullplugProviderStatus[];
}> = ({ statuses }) => {
  if (!statuses.length) return null;

  return (
    <ol className="mb-3 grid gap-2" aria-label="Nullplug provider status">
      {statuses.map((entry) => (
        <li
          key={`${entry.index}:${entry.pluginId}:${entry.providerId ?? "unresolved"}`}
          className="rounded-md border border-border/70 bg-background/60 px-2.5 py-2"
          data-nullplug-provider-status={entry.status}
        >
          <div className="flex items-center justify-between gap-3">
            <span className="min-w-0 truncate text-xs font-medium text-foreground">
              {entry.pluginId}
            </span>
            <span
              className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${PROVIDER_STATUS_CLASSES[entry.status]}`}
            >
              {PROVIDER_STATUS_LABELS[entry.status]}
            </span>
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {entry.scope && entry.providerId
              ? `${entry.scope} · ${entry.providerId}`
              : "unresolved"}
            {entry.version ? ` · v${entry.version}` : ""}
            {entry.effectivePluginId !== entry.pluginId
              ? ` · ${entry.effectivePluginId}`
              : ""}
          </p>
          {entry.message ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {entry.code ? `${entry.code}: ` : ""}
              {entry.message}
            </p>
          ) : null}
        </li>
      ))}
    </ol>
  );
};

export const NullplugPrimitivePanel: React.FC<{
  className?: string;
  primitives?: NullplugUiPrimitive[];
  calls?: readonly DropRuntimeNullplugCallProvenance[];
  status?: NullplugRenderStatus;
}> = ({ className, primitives, calls, status }) => {
  const nullplug = useNullplug();
  const visiblePrimitives = primitives ?? nullplug.primitives;
  const providerStatuses = calls
    ? selectNullplugProviderStatuses(calls)
    : nullplug.providerStatuses;
  if (!visiblePrimitives.length && !providerStatuses.length) return null;
  const visibleStatus = status ?? (calls ? "ready" : nullplug.status);

  return (
    <div
      className={className}
      onMouseDown={(event) => event.stopPropagation()}
      data-nullplug-panel="true"
    >
      <div className="mb-2 flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>Nullplug runtime</span>
        <span>{visibleStatus}</span>
      </div>
      <NullplugProviderStatusList statuses={providerStatuses} />
      {visiblePrimitives.length ? (
        <div className="space-y-3">
          {visiblePrimitives.map((primitive) => (
            <NullplugPrimitive key={primitive.id} primitive={primitive} />
          ))}
        </div>
      ) : null}
      {!nullplug.canSubmit && visiblePrimitives.length ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Runtime submission is waiting for provider sync wiring.
        </p>
      ) : null}
    </div>
  );
};

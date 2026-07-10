import React, {
  createContext,
  useCallback,
  useContext,
  useState,
} from "react";
import useEditorStore from "../../stores/editorStore";
import type {
  JsonValue,
  NullplugMutation,
} from "../../../shared/nullplug/types";
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
  selectNullplugRuntime,
  type NullplugRenderStatus,
  type NullplugRuntimeSelection,
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
  path?: readonly string[];
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
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
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
    snapshotId: primitive?.source?.snapshotId ?? refs.versionId,
    eventId: primitive?.source?.eventId,
    callId: primitive?.source?.callId ?? refs.callId,
  };
};

export const NullplugProvider: React.FC<NullplugProviderProps> = ({
  children,
  submitResponse,
  patchState,
  applyMutation,
}) => (
  <NullplugRuntimeContext.Provider
    value={{ submitResponse, patchState, applyMutation }}
  >
    {children}
  </NullplugRuntimeContext.Provider>
);

export const useNullplug = (
  options: UseNullplugOptions = {},
): UseNullplugResult => {
  const runtime = useContext(NullplugRuntimeContext);
  const [actionStatus, setActionStatus] = useState<NullplugRenderStatus | null>(
    null,
  );
  const selection = useEditorStore((state) =>
    selectNullplugRuntime(
      state.nullplugRenderState,
      state.renderFrame,
      options,
    ),
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
      title={disabled ? "Nullplug runtime submission is not configured." : undefined}
      onClick={() => {
        void nullplug.submitResponse(
          {
            action: primitive.id,
            ...(primitive.intent ? { intent: primitive.intent } : {}),
            ...(primitive.value !== undefined ? { value: primitive.value } : {}),
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
  const disabled = !nullplug.canSubmit || nullplug.status === "submitting";

  return (
    <form
      className="space-y-3 rounded-lg border border-border bg-background/70 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void nullplug.submitResponse(data, primitive);
      }}
    >
      {primitive.title ? (
        <div className="text-sm font-medium text-foreground">{primitive.title}</div>
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
          <label key={field.name} className="grid gap-1 text-xs text-muted-foreground">
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
                    field.options?.findIndex((option) => option.value === value) ?? 0,
                  ),
                )}
                onChange={(event) => {
                  const option = field.options?.[Number(event.target.value)];
                  if (!option) return;
                  setData((current) => ({ ...current, [field.name]: option.value }));
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
        {primitive.submitLabel ?? "Submit"}
      </button>
    </form>
  );
};

export const NullplugCard: React.FC<{ primitive: NullplugCardPrimitive }> = ({
  primitive,
}) => (
  <section className="rounded-lg border border-border bg-background/70 p-3">
    {primitive.title ? (
      <div className="text-sm font-medium text-foreground">{primitive.title}</div>
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
  if (primitive.kind === "action") return <NullplugAction primitive={primitive} />;
  return <NullplugCard primitive={primitive} />;
};

export const NullplugPrimitivePanel: React.FC<{ className?: string }> = ({
  className,
}) => {
  const nullplug = useNullplug();
  if (!nullplug.primitives.length) return null;

  return (
    <div
      className={className}
      onMouseDown={(event) => event.stopPropagation()}
      data-nullplug-panel="true"
    >
      <div className="mb-2 flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>Nullplug runtime</span>
        <span>{nullplug.status}</span>
      </div>
      <div className="space-y-3">
        {nullplug.primitives.map((primitive) => (
          <NullplugPrimitive key={primitive.id} primitive={primitive} />
        ))}
      </div>
      {!nullplug.canSubmit ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Runtime submission is waiting for provider sync wiring.
        </p>
      ) : null}
    </div>
  );
};

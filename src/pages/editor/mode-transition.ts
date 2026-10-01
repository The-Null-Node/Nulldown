import useDropStore, { type DropMode } from "../../stores/drop-store";

/** Changes editor mode; branch-managed routes resume their outbox without republishing the sealed root. */
export function transitionEditorMode(
  mode: DropMode,
  context: { activeDropId?: string; branchManaged: boolean },
) {
  return useDropStore.getState().setMode(mode, {
    activeDropId: context.branchManaged ? undefined : context.activeDropId,
  });
}

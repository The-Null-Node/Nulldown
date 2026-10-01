import { useEffect, useState } from "react";
import createEditor, { type IEditor } from "../../../lib/nulledit/editor";
import type { NullplugRuntime } from "../../../../shared/nullplug/runtime";

/** Runtime and completion fence belonging to one mounted editor route. */
export interface EditorRouteSession {
  editor: IEditor;
  isActive: () => boolean;
}

/** Creates an effect-owned runtime; StrictMode replay creates a fresh lifetime. */
export function useEditorSession(
  runtime: NullplugRuntime,
): EditorRouteSession | null {
  const [session, setSession] = useState<EditorRouteSession | null>(null);
  useEffect(() => {
    let active = true;
    const editor = createEditor({ nullplugRuntime: runtime });
    editor.reset();
    setSession({ editor, isActive: () => active });
    return () => {
      active = false;
      editor.dispose();
    };
  }, [runtime]);
  return session;
}

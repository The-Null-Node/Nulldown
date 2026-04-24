import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { getCaretPosition } from "../utils/getCaretPosition";
import {
  createAnchorState,
  getAnchorKeysFromEventKey,
  onFollow,
  updateAnchorState,
  type AnchorState,
  type ShortcutDefinition,
} from "../utils/shortcutEngine";

interface EditorPaneProps {
  visible?: boolean;
  editorState: {
    editorHidden: boolean;
  };

  markdown: string;
  showPreview: boolean;
  textareaRef: React.RefObject<HTMLTextAreaElement>;
  selectionLocked: boolean;

  onChange: (value: string) => void;
  onSelectionChange: (start: number, end: number) => void;
  onExitEdit: () => void;
}

const EditorPane: React.FC<EditorPaneProps> = ({
  visible = true,
  markdown,
  showPreview,
  textareaRef,
  selectionLocked,
  onChange,
  onSelectionChange,
  onExitEdit,
  editorState,
}: EditorPaneProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuVariant, setMenuVariant] = useState<"base" | "alt">("base");
  const [menuPosition, setMenuPosition] = useState({ x: 0, y: 0 });
  const [isMac, setIsMac] = useState(true);
  const anchorStateRef = useRef<AnchorState>(createAnchorState());
  const menuSuppressedRef = useRef(false);

  useEffect(() => {
    if (typeof navigator !== "undefined") {
      setIsMac(navigator.platform.toLowerCase().includes("mac"));
    }
  }, []);

  const baseMenuItems = useMemo(
    () => [
      { key: "I", label: "Italic", hint: "*text*" },
      { key: "B", label: "Bold", hint: "**text**" },
      { key: "U", label: "Underline", hint: "<u>" },
    ],
    [],
  );

  const altMenuItems = useMemo(
    () => [
      { key: "H", label: "Heading", hint: "##" },
      { key: "I", label: "Image", hint: "![alt]" },
      { key: "E", label: "Embed", hint: "embed(...)" },
    ],
    [],
  );

  const applyTextUpdate = useCallback(
    (nextValue: string, selectionStart: number, selectionEnd: number) => {
      onChange(nextValue);
      requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        if (textarea) {
          textarea.focus();
          textarea.setSelectionRange(selectionStart, selectionEnd);
          if (!selectionLocked) {
            onSelectionChange(selectionStart, selectionEnd);
          }
        }
      });
    },
    [onChange, onSelectionChange, selectionLocked, textareaRef],
  );

  type EncapsulateType =
    | "italic"
    | "bold"
    | "underline"
    | "heading"
    | "image"
    | "embed";

  type EncapsulateContext = {
    start: number;
    end: number;
    selection: string;
  };

  type EncapsulateResult = {
    value: string;
    selectionStart: number;
    selectionEnd: number;
  };

  type EncapsulateHandlers = Record<
    EncapsulateType,
    (context: EncapsulateContext) => EncapsulateResult
  >;

  const onEncapsulate = useCallback(
    (type: EncapsulateType, handlers: EncapsulateHandlers) => {
      const textarea = textareaRef.current;
      if (!textarea) return;

      const start = textarea.selectionStart ?? 0;
      const end = textarea.selectionEnd ?? start;
      const selection = markdown.slice(start, end);
      const handler = handlers[type];

      if (!handler) return;

      const result = handler({ start, end, selection });
      applyTextUpdate(result.value, result.selectionStart, result.selectionEnd);
    },
    [applyTextUpdate, markdown, textareaRef],
  );

  const encapsulateHandlers = useMemo<EncapsulateHandlers>(
    () => ({
      italic: ({ start, end, selection }) => {
        const content = selection || "text";
        const value =
          markdown.slice(0, start) + `*${content}*` + markdown.slice(end);
        const selectionStart = start + 1;
        const selectionEnd = selectionStart + content.length;
        return { value, selectionStart, selectionEnd };
      },
      bold: ({ start, end, selection }) => {
        const content = selection || "text";
        const value =
          markdown.slice(0, start) + `**${content}**` + markdown.slice(end);
        const selectionStart = start + 2;
        const selectionEnd = selectionStart + content.length;
        return { value, selectionStart, selectionEnd };
      },
      underline: ({ start, end, selection }) => {
        const content = selection || "text";
        const value =
          markdown.slice(0, start) + `<u>${content}</u>` + markdown.slice(end);
        const selectionStart = start + 3;
        const selectionEnd = selectionStart + content.length;
        return { value, selectionStart, selectionEnd };
      },
      heading: ({ start, end, selection }) => {
        if (selection) {
          const value =
            markdown.slice(0, start) + `## ${selection}` + markdown.slice(end);
          const selectionStart = start + 3;
          const selectionEnd = selectionStart + selection.length;
          return { value, selectionStart, selectionEnd };
        }

        const value = markdown.slice(0, start) + "## " + markdown.slice(end);
        const selectionStart = start + 3;
        return { value, selectionStart, selectionEnd: selectionStart };
      },
      image: ({ start, end, selection }) => {
        const url = selection || "url";
        const value =
          markdown.slice(0, start) + `![alt](${url})` + markdown.slice(end);
        const selectionStart = start + 2;
        const selectionEnd = selectionStart + 3;
        return { value, selectionStart, selectionEnd };
      },
      embed: ({ start, end, selection }) => {
        const normalizedSelection = selection.trim();
        const defaultUrl = "https://www.youtube.com/embed/";
        const selectedUrl = normalizedSelection || defaultUrl;
        const template = `\`\`\`embed\n${selectedUrl}\n\`\`\``;

        if (selection) {
          const value =
            markdown.slice(0, start) + template + markdown.slice(end);
          const selectionStart = start + template.indexOf(selectedUrl);
          const selectionEnd = selectionStart + selectedUrl.length;
          return { value, selectionStart, selectionEnd };
        }

        const value = markdown.slice(0, start) + template + markdown.slice(end);
        const selectionStart = start + template.indexOf(selectedUrl);
        const selectionEnd = selectionStart + selectedUrl.length;
        return { value, selectionStart, selectionEnd };
      },
    }),
    [markdown],
  );

  const updateMenuPosition = useCallback(() => {
    const textarea = textareaRef.current;
    const container = containerRef.current;
    if (!textarea || !container) return;

    const caretIndex = textarea.selectionStart ?? 0;
    const caret = getCaretPosition(textarea, caretIndex);
    const textareaRect = textarea.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();

    const x = textareaRect.left - containerRect.left + caret.left + 12;
    const y =
      textareaRect.top - containerRect.top + caret.top + caret.lineHeight + 8;

    setMenuPosition({ x, y });
  }, [textareaRef]);

  const openMenu = useCallback(
    (variant: "base" | "alt") => {
      if (editorState.editorHidden || showPreview) return;
      setMenuVariant(variant);
      setMenuOpen(true);
      updateMenuPosition();
    },
    [editorState.editorHidden, showPreview, updateMenuPosition],
  );

  const closeMenu = useCallback(() => setMenuOpen(false), []);

  const shortcuts = useMemo<ShortcutDefinition[]>(
    () => [
      {
        id: "menu-base",
        anchors: ["cmd"],
        onTrigger: (_input, state) => {
          if (menuSuppressedRef.current) return;
          openMenu(state.shift ? "alt" : "base");
        },
      },
      {
        id: "menu-alt",
        anchors: ["cmd", "shift"],
        onTrigger: () => {
          if (menuSuppressedRef.current) return;
          if (menuOpen) {
            setMenuVariant("alt");
            updateMenuPosition();
          } else {
            openMenu("alt");
          }
        },
      },
      {
        id: "italic",
        anchors: ["cmd"],
        key: "i",
        onTrigger: () => {
          onEncapsulate("italic", encapsulateHandlers);
          closeMenu();
        },
      },
      {
        id: "bold",
        anchors: ["cmd"],
        key: "b",
        onTrigger: () => {
          onEncapsulate("bold", encapsulateHandlers);
          closeMenu();
        },
      },
      {
        id: "underline",
        anchors: ["cmd"],
        key: "u",
        onTrigger: () => {
          onEncapsulate("underline", encapsulateHandlers);
          closeMenu();
        },
      },
      {
        id: "heading",
        anchors: ["cmd", "shift"],
        key: "h",
        onTrigger: () => {
          onEncapsulate("heading", encapsulateHandlers);
          closeMenu();
        },
      },
      {
        id: "image",
        anchors: ["cmd", "shift"],
        key: "i",
        onTrigger: () => {
          onEncapsulate("image", encapsulateHandlers);
          closeMenu();
        },
      },
      {
        id: "embed",
        anchors: ["cmd", "shift"],
        key: "e",
        onTrigger: () => {
          onEncapsulate("embed", encapsulateHandlers);
          closeMenu();
        },
      },
    ],
    [
      closeMenu,
      encapsulateHandlers,
      menuOpen,
      onEncapsulate,
      openMenu,
      updateMenuPosition,
    ],
  );

  useLayoutEffect(() => {
    if (!menuOpen || !menuRef.current || !containerRef.current) return;

    const containerRect = containerRef.current.getBoundingClientRect();
    const menuRect = menuRef.current.getBoundingClientRect();

    setMenuPosition((current) => {
      const maxX = containerRect.width - menuRect.width - 8;
      const maxY = containerRect.height - menuRect.height - 8;
      const nextX = Math.min(Math.max(current.x, 8), maxX);
      const nextY = Math.min(Math.max(current.y, 8), maxY);

      if (nextX === current.x && nextY === current.y) {
        return current;
      }

      return { x: nextX, y: nextY };
    });
  }, [menuOpen, menuVariant]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (editorState.editorHidden || showPreview) return;

      const nextState = updateAnchorState(anchorStateRef.current, event);
      anchorStateRef.current = nextState;

      const anchorKeys = getAnchorKeysFromEventKey(event.key);
      if (anchorKeys.length) {
        if (anchorKeys.includes("cmd")) {
          menuSuppressedRef.current = false;
        }
        anchorKeys.forEach((anchor) => {
          onFollow(shortcuts, anchor, nextState);
        });
        return;
      }

      if (!nextState.cmd) return;

      if (
        [
          "ArrowLeft",
          "ArrowRight",
          "ArrowUp",
          "ArrowDown",
          "Home",
          "End",
          "PageUp",
          "PageDown",
        ].includes(event.key)
      ) {
        closeMenu();
        menuSuppressedRef.current = true;
        return;
      }

      if (event.key === "Alt") {
        return;
      }

      const handled = onFollow(shortcuts, event.key, nextState);
      if (handled) {
        event.preventDefault();
      }

      closeMenu();
      menuSuppressedRef.current = true;
    },
    [closeMenu, editorState.editorHidden, shortcuts, showPreview],
  );

  const handleKeyUp = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const nextState = updateAnchorState(anchorStateRef.current, event);
      anchorStateRef.current = nextState;

      if (event.key === "Meta" || event.key === "Control") {
        menuSuppressedRef.current = false;
        closeMenu();
        return;
      }

      if (
        event.key === "Shift" &&
        nextState.cmd &&
        !menuSuppressedRef.current
      ) {
        setMenuVariant("base");
        updateMenuPosition();
        return;
      }

      if (menuOpen && (event.metaKey || event.ctrlKey)) {
        updateMenuPosition();
      }

      if (!selectionLocked) {
        const textarea = textareaRef.current;
        if (textarea) {
          const start = textarea.selectionStart ?? 0;
          const end = textarea.selectionEnd ?? start;
          onSelectionChange(start, end);
        }
      }
    },
    [closeMenu, menuOpen, onSelectionChange, selectionLocked, textareaRef, updateMenuPosition],
  );

  const handleBlur = useCallback(() => {
    closeMenu();
    if (!editorState.editorHidden && !showPreview) {
      onExitEdit();
    }
  }, [closeMenu, editorState.editorHidden, onExitEdit, showPreview]);

  const handleMouseUp = useCallback(
    (event: React.MouseEvent<HTMLTextAreaElement>) => {
      if (menuOpen && (event.metaKey || event.ctrlKey)) {
        updateMenuPosition();
      }
      if (!selectionLocked) {
        const textarea = textareaRef.current;
        if (textarea) {
          const start = textarea.selectionStart ?? 0;
          const end = textarea.selectionEnd ?? start;
          onSelectionChange(start, end);
        }
      }
    },
    [menuOpen, onSelectionChange, selectionLocked, textareaRef, updateMenuPosition],
  );

  const handleSelect = useCallback(() => {
    if (selectionLocked) return;
    const textarea = textareaRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? start;
    onSelectionChange(start, end);
  }, [onSelectionChange, selectionLocked, textareaRef]);

  if (!visible) {
    return null;
  }

  return (
    <div ref={containerRef} className="absolute inset-0 p-4">
      <textarea
        ref={textareaRef}
        value={markdown}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
        onBlur={handleBlur}
        onMouseUp={handleMouseUp}
        onSelect={handleSelect}
        readOnly={editorState.editorHidden}
        placeholder="Ready to take your text."
        className="w-full h-full resize-none bg-card border border-border rounded-md p-4 text-foreground font-mono focus:border-accent focus:outline-none"
        autoFocus
      />

      {menuOpen && !editorState.editorHidden && !showPreview && (
        <div
          className="absolute z-20 pointer-events-none"
          style={{ left: menuPosition.x, top: menuPosition.y }}
        >
          <div
            ref={menuRef}
            className="command-menu-pop pointer-events-auto w-[220px] rounded-md border border-border bg-card/95 text-foreground shadow-lg backdrop-blur-sm"
          >
            <div className="flex items-center justify-between px-3 pt-2 pb-1 text-[10px] uppercase tracking-[0.25em] text-muted">
              <span>{isMac ? "Command" : "Control"}</span>
              <span>{menuVariant === "alt" ? "Shift" : "Base"}</span>
            </div>
            <div className="px-2 pb-2">
              {(menuVariant === "alt" ? altMenuItems : baseMenuItems).map(
                (item) => (
                  <div
                    key={`${menuVariant}-${item.key}`}
                    className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-background/40"
                  >
                    <span className="font-medium">{item.label}</span>
                    <span className="flex items-center gap-2 text-[10px] text-muted">
                      <span className="rounded border border-border px-1.5 py-0.5">
                        {item.key}
                      </span>
                      <span>{item.hint}</span>
                    </span>
                  </div>
                ),
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default EditorPane;

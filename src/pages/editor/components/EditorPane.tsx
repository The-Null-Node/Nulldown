import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { getCaretPosition } from "../utils/getCaretPosition";

interface EditorPaneProps {
  editorState: {
    editorHidden: boolean;
  };

  markdown: string;
  showPreview: boolean;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;

  onChange: (value: string) => void;
  onExitEdit: () => void;
}

const EditorPane: React.FC<EditorPaneProps> = ({
  markdown,
  showPreview,
  textareaRef,
  onChange,
  onExitEdit,
  editorState,
}: EditorPaneProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuVariant, setMenuVariant] = useState<"base" | "alt">("base");
  const [menuPosition, setMenuPosition] = useState({ x: 0, y: 0 });
  const [isMac, setIsMac] = useState(true);

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
      { key: "E", label: "Embed", hint: "<iframe>" },
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
        }
      });
    },
    [onChange, textareaRef],
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

  type EncapsulateHandlers = Record<EncapsulateType, (
    context: EncapsulateContext,
  ) => EncapsulateResult>;

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
          markdown.slice(0, start) +
          `*${content}*` +
          markdown.slice(end);
        const selectionStart = start + 1;
        const selectionEnd = selectionStart + content.length;
        return { value, selectionStart, selectionEnd };
      },
      bold: ({ start, end, selection }) => {
        const content = selection || "text";
        const value =
          markdown.slice(0, start) +
          `**${content}**` +
          markdown.slice(end);
        const selectionStart = start + 2;
        const selectionEnd = selectionStart + content.length;
        return { value, selectionStart, selectionEnd };
      },
      underline: ({ start, end, selection }) => {
        const content = selection || "text";
        const value =
          markdown.slice(0, start) +
          `<u>${content}</u>` +
          markdown.slice(end);
        const selectionStart = start + 3;
        const selectionEnd = selectionStart + content.length;
        return { value, selectionStart, selectionEnd };
      },
      heading: ({ start, end, selection }) => {
        if (selection) {
          const value =
            markdown.slice(0, start) +
            `## ${selection}` +
            markdown.slice(end);
          const selectionStart = start + 3;
          const selectionEnd = selectionStart + selection.length;
          return { value, selectionStart, selectionEnd };
        }

        const value =
          markdown.slice(0, start) + "## " + markdown.slice(end);
        const selectionStart = start + 3;
        return { value, selectionStart, selectionEnd: selectionStart };
      },
      image: ({ start, end, selection }) => {
        const url = selection || "url";
        const value =
          markdown.slice(0, start) +
          `![alt](${url})` +
          markdown.slice(end);
        const selectionStart = start + 2;
        const selectionEnd = selectionStart + 3;
        return { value, selectionStart, selectionEnd };
      },
      embed: ({ start, end, selection }) => {
        if (selection) {
          const template = `<iframe src="${selection}"></iframe>`;
          const value =
            markdown.slice(0, start) +
            template +
            markdown.slice(end);
          const selectionStart = start + template.length;
          return { value, selectionStart, selectionEnd: selectionStart };
        }

        const template = "<iframe src=\"\"></iframe>";
        const value =
          markdown.slice(0, start) + template + markdown.slice(end);
        const selectionStart = start + template.indexOf("src=\"\"") + 5;
        return { value, selectionStart, selectionEnd: selectionStart };
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

    const x =
      textareaRect.left -
      containerRect.left +
      caret.left +
      12;
    const y =
      textareaRect.top -
      containerRect.top +
      caret.top +
      caret.lineHeight +
      8;

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

      const isCommand = event.metaKey || event.ctrlKey;
      if (!isCommand) return;

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
        return;
      }

      if (event.key === "Meta" || event.key === "Control") {
        return;
      }

      if (event.key === "Shift") {
        return;
      }

      const key = event.key.toLowerCase();
      if (event.shiftKey) {
        if (key === "h") {
          event.preventDefault();
          onEncapsulate("heading", encapsulateHandlers);
          closeMenu();
          return;
        }
        if (key === "i") {
          event.preventDefault();
          onEncapsulate("image", encapsulateHandlers);
          closeMenu();
          return;
        }
        if (key === "e") {
          event.preventDefault();
          onEncapsulate("embed", encapsulateHandlers);
          closeMenu();
          return;
        }
      } else {
        if (key === "i") {
          event.preventDefault();
          onEncapsulate("italic", encapsulateHandlers);
          closeMenu();
          return;
        }
        if (key === "b") {
          event.preventDefault();
          onEncapsulate("bold", encapsulateHandlers);
          closeMenu();
          return;
        }
        if (key === "u") {
          event.preventDefault();
          onEncapsulate("underline", encapsulateHandlers);
          closeMenu();
          return;
        }
      }

      openMenu(event.shiftKey ? "alt" : "base");
    },
    [
      closeMenu,
      editorState.editorHidden,
      encapsulateHandlers,
      onEncapsulate,
      openMenu,
      showPreview,
    ],
  );

  const handleKeyUp = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Meta" || event.key === "Control") {
        closeMenu();
        return;
      }

      if (event.key === "Shift" && (event.metaKey || event.ctrlKey)) {
        setMenuVariant("base");
        updateMenuPosition();
        return;
      }

      if (menuOpen && (event.metaKey || event.ctrlKey)) {
        updateMenuPosition();
      }
    },
    [closeMenu, menuOpen, updateMenuPosition],
  );

  const handleBlur = useCallback(() => {
    closeMenu();
    if (!editorState.editorHidden && !showPreview) {
      onExitEdit();
    }
  }, [closeMenu, editorState.editorHidden, onExitEdit, showPreview]);

  const handleMouseUp = useCallback(
    (event: React.MouseEvent<HTMLTextAreaElement>) => {
      if (!menuOpen) return;
      if (event.metaKey || event.ctrlKey) {
        updateMenuPosition();
      }
    },
    [menuOpen, updateMenuPosition],
  );

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

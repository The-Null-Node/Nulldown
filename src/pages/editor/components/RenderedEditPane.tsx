import React, {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
} from "react";
import LoadingFallback from "./LoadingFallback";
import {
  mapMarkdownIndexToPlainTextOffset,
  mapPlainTextOffsetToMarkdownIndex,
} from "../../../lib/markdownText";

const EnhancedMarkdown = lazy(
  () => import("../../../components/EnhancedMarkdown"),
);

interface RenderedEditPaneProps {
  visible?: boolean;
  sourceMarkdown: string;
  renderedMarkdown: string;
  textareaRef: React.RefObject<HTMLTextAreaElement>;
  selectionLocked: boolean;
  allowedUrls?: readonly string[];
  onChange: (value: string) => void;
  onSelectionChange: (start: number, end: number) => void;
  onExitEdit: () => void;
  onRequestAddNetworkHost?: (host: string) => void;
}

interface CaretState {
  visible: boolean;
  left: number;
  top: number;
  height: number;
}

const HIDDEN_CARET: CaretState = {
  visible: false,
  left: 0,
  top: 0,
  height: 0,
};

const getPlainTextOffsetFromPoint = (
  container: HTMLElement,
  clientX: number,
  clientY: number,
): number | null => {
  const doc = container.ownerDocument;
  if (!doc) return null;

  const caretRangeFromPoint = (doc as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  }).caretRangeFromPoint;

  const caretPositionFromPoint = (doc as Document & {
    caretPositionFromPoint?: (
      x: number,
      y: number,
    ) => { offsetNode: Node; offset: number } | null;
  }).caretPositionFromPoint;

  let range: Range | null = null;

  if (caretRangeFromPoint) {
    range = caretRangeFromPoint.call(doc, clientX, clientY);
  } else if (caretPositionFromPoint) {
    const position = caretPositionFromPoint.call(doc, clientX, clientY);

    if (position) {
      range = doc.createRange();
      range.setStart(position.offsetNode, position.offset);
      range.collapse(true);
    }
  }

  if (!range || !container.contains(range.startContainer)) {
    return null;
  }

  const preRange = doc.createRange();
  preRange.selectNodeContents(container);
  preRange.setEnd(range.startContainer, range.startOffset);

  return preRange.toString().length;
};

const createRangeAtPlainTextOffset = (
  container: HTMLElement,
  plainTextOffset: number,
): Range | null => {
  const doc = container.ownerDocument;
  if (!doc) return null;

  const normalizedOffset = Math.max(0, plainTextOffset);
  const walker = doc.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let remaining = normalizedOffset;
  let currentNode = walker.nextNode();

  while (currentNode) {
    const textNode = currentNode as Text;
    const length = textNode.textContent?.length ?? 0;

    if (remaining <= length) {
      const range = doc.createRange();
      range.setStart(textNode, Math.min(remaining, length));
      range.collapse(true);
      return range;
    }

    remaining -= length;
    currentNode = walker.nextNode();
  }

  const fallback = doc.createRange();
  fallback.selectNodeContents(container);
  fallback.collapse(false);
  return fallback;
};

const toCaretState = (
  container: HTMLElement,
  range: Range,
): CaretState | null => {
  const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
  if (!rect) return null;

  const containerRect = container.getBoundingClientRect();
  const lineHeight =
    Number.parseFloat(window.getComputedStyle(container).lineHeight) || 20;

  return {
    visible: true,
    left: rect.left - containerRect.left + container.scrollLeft,
    top: rect.top - containerRect.top + container.scrollTop,
    height: rect.height || lineHeight,
  };
};

const RenderedEditPane: React.FC<RenderedEditPaneProps> = ({
  visible = true,
  sourceMarkdown,
  renderedMarkdown,
  textareaRef,
  selectionLocked,
  allowedUrls,
  onChange,
  onSelectionChange,
  onExitEdit,
  onRequestAddNetworkHost,
}) => {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [hasFocus, setHasFocus] = useState(false);
  const [caret, setCaret] = useState<CaretState>(HIDDEN_CARET);

  const syncSelection = useCallback(() => {
    if (selectionLocked) {
      return;
    }

    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? start;
    onSelectionChange(start, end);
  }, [onSelectionChange, selectionLocked, textareaRef]);

  const updateCaret = useCallback(() => {
    if (!visible || !hasFocus || !container) {
      setCaret(HIDDEN_CARET);
      return;
    }

    const textarea = textareaRef.current;
    if (!textarea) {
      setCaret(HIDDEN_CARET);
      return;
    }

    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? start;

    if (start !== end) {
      setCaret(HIDDEN_CARET);
      return;
    }

    const plainOffset = mapMarkdownIndexToPlainTextOffset(sourceMarkdown, start);
    const range = createRangeAtPlainTextOffset(container, plainOffset);

    if (!range) {
      setCaret(HIDDEN_CARET);
      return;
    }

    const nextCaret = toCaretState(container, range);
    setCaret(nextCaret ?? HIDDEN_CARET);
  }, [container, hasFocus, sourceMarkdown, textareaRef, visible]);

  useLayoutEffect(() => {
    updateCaret();
  }, [renderedMarkdown, sourceMarkdown, updateCaret]);

  useEffect(() => {
    if (!visible || !container) {
      return;
    }

    const rerenderCaret = () => {
      requestAnimationFrame(() => {
        updateCaret();
      });
    };

    container.addEventListener("scroll", rerenderCaret);
    window.addEventListener("resize", rerenderCaret);

    return () => {
      container.removeEventListener("scroll", rerenderCaret);
      window.removeEventListener("resize", rerenderCaret);
    };
  }, [container, updateCaret, visible]);

  const focusTextareaAt = useCallback(
    (markdownIndex: number) => {
      requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        if (!textarea) {
          return;
        }

        textarea.focus();
        textarea.setSelectionRange(markdownIndex, markdownIndex);
        if (!selectionLocked) {
          onSelectionChange(markdownIndex, markdownIndex);
        }

        updateCaret();
      });
    },
    [onSelectionChange, selectionLocked, textareaRef, updateCaret],
  );

  const handleMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (event.button !== 0 || !container) {
        return;
      }

      const plainOffset = getPlainTextOffsetFromPoint(
        container,
        event.clientX,
        event.clientY,
      );
      const markdownIndex = mapPlainTextOffsetToMarkdownIndex(
        sourceMarkdown,
        plainOffset ?? 0,
      );

      focusTextareaAt(markdownIndex);
      event.preventDefault();
      event.stopPropagation();
    },
    [container, focusTextareaAt, sourceMarkdown],
  );

  if (!visible) {
    return null;
  }

  return (
    <div className="absolute inset-0 p-4">
      <div
        ref={setContainer}
        onMouseDown={handleMouseDown}
        className="relative h-full overflow-auto rounded-md border border-border bg-card cursor-text"
      >
        <textarea
          ref={textareaRef}
          value={sourceMarkdown}
          onChange={(event) => {
            onChange(event.target.value);
            syncSelection();
            updateCaret();
          }}
          onFocus={() => {
            setHasFocus(true);
            syncSelection();
            updateCaret();
          }}
          onBlur={() => {
            setHasFocus(false);
            setCaret(HIDDEN_CARET);
            onExitEdit();
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onExitEdit();
              return;
            }

            requestAnimationFrame(() => {
              syncSelection();
              updateCaret();
            });
          }}
          onKeyUp={() => {
            syncSelection();
            updateCaret();
          }}
          onSelect={() => {
            syncSelection();
            updateCaret();
          }}
          onMouseUp={() => {
            syncSelection();
            updateCaret();
          }}
          autoFocus
          spellCheck={false}
          className="pointer-events-none absolute inset-0 h-full w-full resize-none opacity-0"
          style={{ caretColor: "transparent" }}
          aria-hidden="true"
        />

        {caret.visible ? (
          <div
            className="pointer-events-none absolute z-10 w-px bg-accent"
            style={{
              left: caret.left,
              top: caret.top,
              height: caret.height,
            }}
          />
        ) : null}

        <div className="relative z-0 p-4">
          <Suspense fallback={<LoadingFallback />}>
            <EnhancedMarkdown
              allowedUrls={allowedUrls}
              callbacks={{ onRequestAddNetworkHost }}
            >
              {renderedMarkdown || sourceMarkdown || "*Click to edit*"}
            </EnhancedMarkdown>
          </Suspense>
        </div>
      </div>
    </div>
  );
};

export default RenderedEditPane;

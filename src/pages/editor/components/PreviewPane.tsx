import React, { Suspense, lazy, useCallback, useRef } from "react";
import LoadingFallback from "./LoadingFallback";
import { mapPlainTextOffsetToMarkdownIndex } from "../../../lib/markdownText";

const EnhancedMarkdown = lazy(
  () => import("../../../components/EnhancedMarkdown"),
);

interface PreviewPaneProps {
  markdown: string;
  showPreview: boolean;
  onRequestEdit?: (selection: { start: number; end: number } | null) => void;
}

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

  if (!range || !container.contains(range.startContainer)) return null;

  const preRange = doc.createRange();
  preRange.selectNodeContents(container);
  preRange.setEnd(range.startContainer, range.startOffset);
  return preRange.toString().length;
};

const PreviewPane: React.FC<PreviewPaneProps> = ({
  markdown,
  showPreview,
  onRequestEdit,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);

  const handleMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (event.button !== 0 || !onRequestEdit) return;
      const container = containerRef.current;
      if (!container) {
        onRequestEdit(null);
        return;
      }

      const offset = getPlainTextOffsetFromPoint(
        container,
        event.clientX,
        event.clientY,
      );

      if (offset === null) {
        onRequestEdit(null);
        return;
      }

      const markdownIndex = mapPlainTextOffsetToMarkdownIndex(markdown, offset);
      onRequestEdit({ start: markdownIndex, end: markdownIndex });
      event.preventDefault();
      event.stopPropagation();
    },
    [markdown, onRequestEdit],
  );

  if (!showPreview) return null;

  return (
    <div
      ref={containerRef}
      onMouseDown={handleMouseDown}
      className="absolute inset-0 p-4 overflow-auto bg-card border border-border rounded-md"
    >
      <Suspense fallback={<LoadingFallback />}>
        <EnhancedMarkdown>
          {markdown || "*Click to edit*"}
        </EnhancedMarkdown>
      </Suspense>
    </div>
  );
};

export default PreviewPane;

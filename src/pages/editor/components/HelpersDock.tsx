import React, { Suspense, lazy } from "react";
import LoadingFallback from "./LoadingFallback";

const MarkdownHelpers = lazy(
  () => import("../../../components/MarkdownHelpers"),
);

interface HelpersDockProps {
  editorHidden: boolean;
  showPreview: boolean;
  onInsert: (text: string) => void;
}

const HelpersDock: React.FC<HelpersDockProps> = ({
  editorHidden,
  showPreview,
  onInsert,
}) => {
  if (editorHidden || showPreview) return null;

  return (
    <div className="absolute bottom-0 left-0 right-0 p-4 bg-background z-10">
      <Suspense fallback={<LoadingFallback />}>
        <MarkdownHelpers onInsert={onInsert} />
      </Suspense>
    </div>
  );
};

export default HelpersDock;

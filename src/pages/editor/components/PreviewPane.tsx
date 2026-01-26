import React, { Suspense, lazy } from "react";
import LoadingFallback from "./LoadingFallback";

const EnhancedMarkdown = lazy(
  () => import("../../../components/EnhancedMarkdown"),
);

interface PreviewPaneProps {
  editorHidden: boolean;
  markdown: string;
  showPreview: boolean;
}

const PreviewPane: React.FC<PreviewPaneProps> = ({
  editorHidden,
  markdown,
  showPreview,
}) => {
  if (!showPreview) return null;

  return (
    <div className="absolute inset-0 p-4 overflow-auto bg-card border border-border rounded-md">
      <Suspense fallback={<LoadingFallback />}>
        <EnhancedMarkdown>
          {markdown || "*Preview will appear here*"}
        </EnhancedMarkdown>
      </Suspense>
    </div>
  );
};

export default PreviewPane;

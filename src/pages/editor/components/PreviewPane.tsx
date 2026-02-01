import React, { Suspense, lazy } from "react";
import LoadingFallback from "./LoadingFallback";

const EnhancedMarkdown = lazy(
  () => import("../../../components/EnhancedMarkdown"),
);

interface PreviewPaneProps {
  markdown: string;
  showPreview: boolean;
}

const PreviewPane: React.FC<PreviewPaneProps> = ({
  markdown,
  showPreview,
}) => {
  if (!showPreview) return null;

  return (
    <div className="absolute inset-0 p-4 overflow-auto bg-card border border-border rounded-md">
      <Suspense fallback={<LoadingFallback />}>
        <EnhancedMarkdown>
          {markdown || "*Click to edit*"}
        </EnhancedMarkdown>
      </Suspense>
    </div>
  );
};

export default PreviewPane;

import React from "react";

const LoadingFallback: React.FC = () => (
  <div className="p-4 flex justify-center items-center h-full">
    <div className="animate-pulse text-muted">Loading...</div>
  </div>
);

export default LoadingFallback;

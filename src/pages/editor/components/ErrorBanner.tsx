import React from "react";

interface ErrorBannerProps {
  message: string;
}

const ErrorBanner: React.FC<ErrorBannerProps> = ({ message }) => (
  <div className="absolute top-2 left-4 right-4 z-10 bg-error/20 border border-error text-error-light p-3 rounded-md text-sm">
    {message}
  </div>
);

export default ErrorBanner;

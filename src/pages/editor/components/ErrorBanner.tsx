import React from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";

interface ErrorBannerProps {
  message: string;
}

const ErrorBanner: React.FC<ErrorBannerProps> = ({ message }) => (
  <div className="absolute top-2 left-4 right-4 z-10">
    <Alert
      variant="destructive"
      className="border-error/60 bg-error/20 text-error-light"
    >
      <AlertDescription className="text-error-light">{message}</AlertDescription>
    </Alert>
  </div>
);

export default ErrorBanner;

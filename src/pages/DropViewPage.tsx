import React, { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import EnhancedMarkdown from '../components/EnhancedMarkdown';
import ThemePicker from '../components/ThemePicker';

function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = title;
  }, [title]);
}

const DropViewPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const [dropContent, setDropContent] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) {
      setError("No drop ID provided.");
      setIsLoading(false);
      return;
    }

    const fetchDrop = async () => {
      setIsLoading(true);
      setError(null);

      try {
        const response = await fetch(`/api/get/${id}`);
        if (response.status === 404) {
          setError("Drop not found.");
          setDropContent(null);
          return;
        }
        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(errorText || `Failed to fetch drop: ${response.statusText}`);
        }
        const content = await response.text(); // Assuming plain text content
        setDropContent(content);
      } catch (err: any) {
        console.error("Failed to fetch drop:", err);
        setError(err.message || "An error occurred while fetching the drop.");
        setDropContent(null);
      } finally {
        setIsLoading(false);
      }
    };

    fetchDrop();
  }, [id]);

  // Set document title based on drop content (basic version)
  const pageTitle = isLoading 
    ? "Loading Drop... | Nulldown" 
    : error 
    ? "Error | Nulldown" 
    : dropContent 
    ? `${dropContent.substring(0, 30).split('\n')[0]}... | Nulldown`
    : "Drop Not Found | Nulldown";
  useDocumentTitle(pageTitle);

  if (isLoading) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-background">
        <div className="animate-pulse text-accent font-medium">Loading drop...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-background">
        <div className="text-center max-w-md">
          <p className="text-error-light mb-4">{error}</p>
          <Link to="/" className="text-accent hover:underline text-sm">
            Create a new Nulldown
          </Link>
        </div>
      </div>
    );
  }

  if (!dropContent) { // Should be covered by error state, but as a fallback
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-background">
        <div className="text-center max-w-md">
          <p className="text-muted mb-4">Drop not found or content is empty.</p>
          <Link to="/" className="text-accent hover:underline text-sm">
            Create a new Nulldown
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 flex flex-col bg-background">
      <div className="border-b border-border p-4 flex justify-between items-center">
        <Link to="/" className="text-sm text-accent hover:underline">NULLDOWN</Link>
        <div className="flex items-center gap-3">
          <ThemePicker />
          <div className="text-xs text-muted">Drop ID: {id}</div>
        </div>
      </div>
      
      <div className="flex-1 overflow-auto p-4">
        <div className="max-w-3xl mx-auto bg-card border border-border rounded-md p-6">
          <EnhancedMarkdown>{dropContent}</EnhancedMarkdown>
        </div>
        
        <div className="mt-6 text-center">
          <Link to="/" className="text-accent hover:underline text-sm inline-flex items-center transition-colors">
            Create another Nulldown
          </Link>
        </div>
      </div>
    </div>
  );
};

export default DropViewPage; 

import React, { useEffect, useRef, useState } from 'react';
import mermaid from 'mermaid';

interface MermaidRendererProps {
  chart: string;
}

const MermaidRenderer: React.FC<MermaidRendererProps> = ({ chart }) => {
  const [svg, setSvg] = useState<string>('');
  const [hasError, setHasError] = useState<boolean>(false);
  const mermaidRef = useRef<HTMLDivElement>(null);
  const uniqueId = `mermaid-${Math.random().toString(36).substring(2, 11)}`;

  useEffect(() => {
    // Initialize mermaid with preferred settings
    mermaid.initialize({
      startOnLoad: false,
      theme: 'dark', // Use 'default' for light theme or 'dark' for dark theme
      securityLevel: 'loose', // This can be set to 'strict' for better security if needed
      fontFamily: 'monospace',
    });

    const renderChart = async () => {
      if (!chart) return;
      
      try {
        // Reset error state
        setHasError(false);
        
        // Render the Mermaid diagram
        const { svg } = await mermaid.render(uniqueId, chart.trim());
        setSvg(svg);
      } catch (error) {
        console.error('Error rendering Mermaid diagram:', error);
        setHasError(true);
      }
    };

    renderChart();
  }, [chart, uniqueId]);

  if (hasError) {
    return (
      <div className="bg-error/20 border border-error text-error-light p-4 rounded-md my-4">
        <p className="font-medium">Failed to render Mermaid diagram.</p>
        <pre className="mt-2 bg-card p-3 rounded overflow-x-auto text-sm">
          {chart}
        </pre>
      </div>
    );
  }

  if (svg) {
    return <div className="my-4" dangerouslySetInnerHTML={{ __html: svg }} />;
  }

  return (
    <div ref={mermaidRef} className="my-4 flex justify-center items-center p-4 bg-card rounded-md">
      <div className="animate-pulse text-muted">Rendering diagram...</div>
    </div>
  );
};

export default MermaidRenderer; 
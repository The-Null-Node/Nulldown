import React, { useEffect, useRef, useState, memo } from 'react';
import mermaid from 'mermaid';
import { useTheme } from '../theme/themeContext';

interface MermaidRendererProps {
  chart: string;
}

const MermaidRenderer: React.FC<MermaidRendererProps> = memo(({ chart }) => {
  const { theme } = useTheme();
  const [svg, setSvg] = useState<string>('');
  const [hasError, setHasError] = useState<boolean>(false);
  const mermaidRef = useRef<HTMLDivElement>(null);
  const uniqueId = useRef(`mermaid-${Math.random().toString(36).substring(2, 11)}`).current;

  useEffect(() => {
    mermaid.initialize({
      startOnLoad: false,
      theme: theme.mode === 'dark' ? 'dark' : 'default',
      securityLevel: 'loose',
      fontFamily: 'monospace',
    });
  }, [theme.mode]);

  useEffect(() => {
    // Skip if no chart
    if (!chart) return;
    
    let isMounted = true;
    
    const renderChart = async () => {
      try {
        // Reset error state
        if (isMounted) setHasError(false);
        
        // Render the Mermaid diagram
        const { svg } = await mermaid.render(uniqueId, chart.trim());
        if (isMounted) setSvg(svg);
      } catch (error) {
        console.error('Error rendering Mermaid diagram:', error);
        if (isMounted) setHasError(true);
      }
    };

    renderChart();
    
    return () => {
      isMounted = false;
    };
  }, [chart, uniqueId, theme.mode]);

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
});

MermaidRenderer.displayName = 'MermaidRenderer';

export default MermaidRenderer; 

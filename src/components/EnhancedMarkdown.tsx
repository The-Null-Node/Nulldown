import React, { useDeferredValue, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import MermaidRenderer from './MermaidRenderer';
import 'katex/dist/katex.min.css';
import { useTheme } from '../theme/themeContext';
import { syntaxThemeStyles } from '../theme/syntaxThemes';

interface EnhancedMarkdownProps {
  children: string;
}

// Define plugins outside the component to prevent recreating on each render
const remarkPlugins = [remarkGfm, remarkMath as any];
const rehypePlugins = [rehypeKatex as any];

const EnhancedMarkdown: React.FC<EnhancedMarkdownProps> = React.memo(({ children }) => {
  const { theme } = useTheme();
  const syntaxStyle = syntaxThemeStyles[theme.syntax] ?? syntaxThemeStyles.vscDarkPlus;

  const markdownComponents = useMemo(
    () => ({
      // Enhanced table rendering
      table: ({ node, ...props }: any) => (
        <div className="my-4 overflow-x-auto">
          <table className="min-w-full divide-y divide-border" {...props} />
        </div>
      ),
      thead: ({ node, ...props }: any) => (
        <thead className="bg-card/60" {...props} />
      ),
      th: ({ node, ...props }: any) => (
        <th className="px-4 py-3 text-left text-xs font-medium text-muted uppercase tracking-wider" {...props} />
      ),
      td: ({ node, ...props }: any) => (
        <td className="px-4 py-3 text-sm" {...props} />
      ),
      tr: ({ node, isHeader, ...props }: any) => (
        <tr className={isHeader ? '' : 'border-t border-border'} {...props} />
      ),
      // Enhanced code block rendering with Mermaid support
      code: ({ node, inline, className, children, ...props }: any) => {
        const match = /language-(\w+)/.exec(className || '');
        const language = match && match[1] ? match[1] : '';

        // Render Mermaid diagrams
        if (language === 'mermaid') {
          return <MermaidRenderer chart={String(children).trim()} />;
        }

        // Render regular code blocks
        return !inline && match ? (
          <SyntaxHighlighter
            style={syntaxStyle as any}
            language={language}
            PreTag="div"
            className="rounded-md my-4"
            {...props}
          >
            {String(children).replace(/\n$/, '')}
          </SyntaxHighlighter>
        ) : (
          <code className={className} {...props}>
            {children}
          </code>
        );
      },
    }),
    [syntaxStyle],
  );

  // Use deferred value to prevent blocking the main thread during large markdown processing
  const deferredMarkdown = useDeferredValue(children);
  
  return (
    <ReactMarkdown
      className="prose max-w-none"
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      components={markdownComponents}
      skipHtml // For security, skip HTML parsing
    >
      {deferredMarkdown}
    </ReactMarkdown>
  );
});

EnhancedMarkdown.displayName = 'EnhancedMarkdown';

export default EnhancedMarkdown; 

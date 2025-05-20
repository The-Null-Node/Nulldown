import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import MermaidRenderer from './MermaidRenderer';
import 'katex/dist/katex.min.css';

interface EnhancedMarkdownProps {
  children: string;
}

const EnhancedMarkdown: React.FC<EnhancedMarkdownProps> = ({ children }) => {
  return (
    <ReactMarkdown
      className="prose max-w-none"
      remarkPlugins={[remarkGfm, remarkMath as any]}
      rehypePlugins={[rehypeKatex as any]}
      components={{
        // Enhanced table rendering
        table: ({ node, ...props }) => (
          <div className="my-4 overflow-x-auto">
            <table className="min-w-full divide-y divide-border" {...props} />
          </div>
        ),
        thead: ({ node, ...props }) => (
          <thead className="bg-card/60" {...props} />
        ),
        th: ({ node, ...props }) => (
          <th className="px-4 py-3 text-left text-xs font-medium text-muted uppercase tracking-wider" {...props} />
        ),
        td: ({ node, ...props }) => (
          <td className="px-4 py-3 text-sm" {...props} />
        ),
        tr: ({ node, isHeader, ...props }) => (
          <tr className={isHeader ? '' : 'border-t border-border'} {...props} />
        ),
        // Enhanced code block rendering with Mermaid support
        code: ({ node, inline, className, children, ...props }) => {
          const match = /language-(\w+)/.exec(className || '');
          const language = match && match[1] ? match[1] : '';

          // Render Mermaid diagrams
          if (language === 'mermaid') {
            return <MermaidRenderer chart={String(children).trim()} />;
          }

          // Render regular code blocks
          return !inline && match ? (
            <SyntaxHighlighter
              style={vscDarkPlus as any}
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
      }}
    >
      {children}
    </ReactMarkdown>
  );
};

export default EnhancedMarkdown; 
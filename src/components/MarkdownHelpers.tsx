import React from 'react';

interface MarkdownHelperProps {
  onInsert: (text: string) => void;
}

// Examples for Mermaid diagrams and Markdown tables
const MERMAID_EXAMPLES = [
  {
    name: 'Flowchart',
    code: `\`\`\`mermaid
graph TD
    A[Start] --> B{Is it working?}
    B -->|Yes| C[Great!]
    B -->|No| D[Debug]
    D --> B
\`\`\``,
  },
  {
    name: 'Sequence Diagram',
    code: `\`\`\`mermaid
sequenceDiagram
    participant User
    participant System
    User->>System: Submit data
    System->>System: Process data
    System-->>User: Confirm success
\`\`\``,
  },
  {
    name: 'Gantt Chart',
    code: `\`\`\`mermaid
gantt
    title Project Schedule
    dateFormat YYYY-MM-DD
    section Phase 1
    Planning       : 2023-01-01, 30d
    Development    : after Planning, 60d
    section Phase 2
    Testing        : after Development, 30d
    Deployment     : after Testing, 10d
\`\`\``,
  },
];

const TABLE_EXAMPLES = [
  {
    name: 'Simple Table',
    code: `| Header 1 | Header 2 | Header 3 |
| -------- | -------- | -------- |
| Cell 1   | Cell 2   | Cell 3   |
| Cell 4   | Cell 5   | Cell 6   |`,
  },
  {
    name: 'Aligned Table',
    code: `| Left-aligned | Center-aligned | Right-aligned |
| :----------- | :-------------: | -------------: |
| Left         | Center          | Right          |
| Text         | Text            | Text           |`,
  },
];

const LATEX_EXAMPLES = [
  {
    name: 'Inline Math',
    code: `This is an inline math expression: $E = mc^2$`,
  },
  {
    name: 'Block Math',
    code: `Here's a block math expression:

$$
\\frac{d}{dx}\\left( \\int_{0}^{x} f(u)\\,du\\right)=f(x)
$$`,
  },
  {
    name: 'Matrix',
    code: `Here's a matrix:

$$
\\begin{pmatrix}
a & b \\\\
c & d
\\end{pmatrix}
$$`,
  },
  {
    name: 'Equation System',
    code: `Here's a system of equations:

$$
\\begin{cases}
x + y = 1 \\\\
x - y = 2
\\end{cases}
$$`,
  },
];

export const MarkdownHelpers: React.FC<MarkdownHelperProps> = ({ onInsert }) => {
  return (
    <div className="mt-4">
      <div className="mb-4 text-sm">
        <h3 className="text-accent font-medium mb-2">
          Mermaid Diagrams Help
        </h3>
        <div className="px-4 py-3 bg-card rounded-md">
          <p className="text-muted mb-3">
            You can add diagrams to your markdown using Mermaid. Here are some examples:
          </p>
          <div className="grid grid-cols-1 gap-3">
            {MERMAID_EXAMPLES.map((example) => (
              <div key={example.name} className="border border-border rounded-md p-3">
                <div className="flex justify-between items-center mb-2">
                  <h4 className="text-accent font-medium">{example.name}</h4>
                  <button
                    onClick={() => onInsert(example.code)}
                    className="text-xs bg-accent/10 hover:bg-accent/20 text-accent px-2 py-1 rounded"
                  >
                    Insert
                  </button>
                </div>
                <pre className="text-xs overflow-x-auto p-2 bg-background rounded">
                  {example.code}
                </pre>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="mb-4 text-sm">
        <h3 className="text-accent font-medium mb-2">
          Markdown Tables Help
        </h3>
        <div className="px-4 py-3 bg-card rounded-md">
          <p className="text-muted mb-3">
            You can create tables in your markdown. Here are some examples:
          </p>
          <div className="grid grid-cols-1 gap-3">
            {TABLE_EXAMPLES.map((example) => (
              <div key={example.name} className="border border-border rounded-md p-3">
                <div className="flex justify-between items-center mb-2">
                  <h4 className="text-accent font-medium">{example.name}</h4>
                  <button
                    onClick={() => onInsert(example.code)}
                    className="text-xs bg-accent/10 hover:bg-accent/20 text-accent px-2 py-1 rounded"
                  >
                    Insert
                  </button>
                </div>
                <pre className="text-xs overflow-x-auto p-2 bg-background rounded">
                  {example.code}
                </pre>
              </div>
            ))}
          </div>
        </div>
      </div>

      <details className="mb-4 text-sm">
        <summary className="cursor-pointer text-accent hover:underline font-medium mb-2">
          LaTeX Math Help
        </summary>
        <div className="px-4 py-3 bg-card rounded-md">
          <p className="text-muted mb-3">
            You can add mathematical expressions using LaTeX. Here are some examples:
          </p>
          <div className="grid grid-cols-1 gap-3">
            {LATEX_EXAMPLES.map((example) => (
              <div key={example.name} className="border border-border rounded-md p-3">
                <div className="flex justify-between items-center mb-2">
                  <h4 className="text-accent font-medium">{example.name}</h4>
                  <button
                    onClick={() => onInsert(example.code)}
                    className="text-xs bg-accent/10 hover:bg-accent/20 text-accent px-2 py-1 rounded"
                  >
                    Insert
                  </button>
                </div>
                <pre className="text-xs overflow-x-auto p-2 bg-background rounded">
                  {example.code}
                </pre>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default MarkdownHelpers; 
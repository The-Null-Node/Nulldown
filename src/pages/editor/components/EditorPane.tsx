import React from "react";

interface EditorPaneProps {
  editorState: {
    editorHidden: boolean;
    toggleEditorVisibility: () => void;
  };

  markdown: string;
  showPreview: boolean;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;

  onChange: (value: string) => void;
}

const EditorPane: React.FC<EditorPaneProps> = ({
  markdown,
  showPreview,
  textareaRef,
  onChange,
  editorState,
}: EditorPaneProps) => {
  return (
    <div className="absolute inset-0 p-4">
      <textarea
        ref={textareaRef}
        value={markdown}
        onChange={(event) => onChange(event.target.value)}
        readOnly={editorState.editorHidden}
        placeholder="Ready to take your text."
        className="w-full h-full resize-none bg-card border border-border rounded-md p-4 text-foreground font-mono focus:border-accent focus:outline-none"
        autoFocus
      />
    </div>
  );
};

export default EditorPane;

import { useCallback } from "react";
import type { RefObject } from "react";

export function useInsertText(
  textareaRef: RefObject<HTMLTextAreaElement | null>,
  markdown: string,
  setTextContent: (value: string) => void,
) {
  return useCallback(
    (text: string) => {
      if (textareaRef && textareaRef.current) {
        const cursorPos = textareaRef.current.selectionStart;
        const textBefore = markdown.substring(0, cursorPos);
        const textAfter = markdown.substring(textareaRef.current.selectionEnd);

        const prefix =
          cursorPos > 0 && textBefore.charAt(textBefore.length - 1) !== "\n"
            ? "\n\n"
            : "";

        const suffix =
          textAfter.length > 0 && textAfter.charAt(0) !== "\n" ? "\n\n" : "";

        onst newText = textBefore + prefix + text + suffix + textAfter;

        setTextContent(newText);

        setTimeout(() => {
          if (textareaRef.current) {
            textareaRef.current.focus();
            const newPosition =
              cursorPos + prefix.length + text.length + suffix.length;
            textareaRef.current.setSelectionRange(newPosition, newPosition);
          }
        }, 0);
      } else {
        setTextContent(markdown + "\n\n" + text + "\n\n");
      }
    },
    [markdown, setTextContent, textareaRef],
  );
}

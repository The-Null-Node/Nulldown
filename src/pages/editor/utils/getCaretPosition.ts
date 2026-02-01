export interface CaretPosition {
  left: number;
  top: number;
  lineHeight: number;
}

const mirrorStyles = [
  "boxSizing",
  "fontFamily",
  "fontSize",
  "fontStyle",
  "fontWeight",
  "letterSpacing",
  "lineHeight",
  "padding",
  "border",
  "textAlign",
  "textTransform",
  "textIndent",
  "textRendering",
  "wordSpacing",
  "whiteSpace",
];

export function getCaretPosition(
  textarea: HTMLTextAreaElement,
  caretIndex: number,
): CaretPosition {
  const computed = window.getComputedStyle(textarea);
  const div = document.createElement("div");

  div.style.position = "absolute";
  div.style.visibility = "hidden";
  div.style.whiteSpace = "pre-wrap";
  div.style.wordWrap = "break-word";
  div.style.overflow = "hidden";
  div.style.width = `${textarea.clientWidth}px`;

  mirrorStyles.forEach((style) => {
    const value = computed.getPropertyValue(style);
    if (value) {
      (div.style as CSSStyleDeclaration).setProperty(style, value);
    }
  });

  const before = textarea.value.substring(0, caretIndex);
  const after = textarea.value.substring(caretIndex);

  div.textContent = before;

  const span = document.createElement("span");
  span.textContent = after.length > 0 ? after[0] : ".";
  div.appendChild(span);

  document.body.appendChild(div);

  const spanRect = span.getBoundingClientRect();
  const divRect = div.getBoundingClientRect();

  document.body.removeChild(div);

  const lineHeight = parseFloat(computed.lineHeight) ||
    parseFloat(computed.fontSize) ||
    16;

  return {
    left: spanRect.left - divRect.left - textarea.scrollLeft,
    top: spanRect.top - divRect.top - textarea.scrollTop,
    lineHeight,
  };
}

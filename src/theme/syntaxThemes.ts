import {
  dracula,
  ghcolors,
  gruvboxDark,
  gruvboxLight,
  materialOceanic,
  nightOwl,
  nord,
  oneDark,
  oneLight,
  solarizedDarkAtom,
  solarizedlight,
  vscDarkPlus,
  vs,
  xonokai,
} from "react-syntax-highlighter/dist/esm/styles/prism";

export const syntaxThemeStyles = {
  dracula,
  ghcolors,
  gruvboxDark,
  gruvboxLight,
  materialOceanic,
  nightOwl,
  nord,
  oneDark,
  oneLight,
  solarizedDarkAtom,
  solarizedlight,
  vscDarkPlus,
  vs,
  xonokai,
};

export type SyntaxThemeKey = keyof typeof syntaxThemeStyles;

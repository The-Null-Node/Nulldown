import tseslint from "typescript-eslint";

const authoredPaths = [
  "*.{js,cjs,mjs,jsx,ts,tsx,mts,cts}",
  "{src,shared,functions,packages,scripts,bin,lib}/**/*.{js,cjs,mjs,jsx,ts,tsx,mts,cts}",
];

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      "**/.git/**",
      "**/.wrangler/**",
      "**/.cache/**",
      "**/.diff-auth/**",
      "**/.nulldown-data/**",
      "**/.env*",
      "**/.dev.vars*",
      "src/__embedded.ts",
      "public/**",
      "themes/**",
      "nulldown-mcp/**",
      ".opencode/**",
    ],
  },
  {
    files: authoredPaths,
    rules: {
      "no-unused-vars": "error",
    },
  },
  {
    files: [
      "*.{ts,tsx,mts,cts}",
      "{src,shared,functions,packages,scripts,bin,lib}/**/*.{ts,tsx,mts,cts}",
    ],
    languageOptions: {
      parser: tseslint.parser,
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],
    },
  },
];

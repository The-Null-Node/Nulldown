import type { Config } from 'tailwindcss';

export default {
  content: [
    "./index.html", // Vite entry point
    "./src/**/*.{js,ts,jsx,tsx}", // Source files
  ],
  theme: {
    extend: {
      // Nulldown specific theme extensions
      // These colors are now defined as CSS variables in globals.css
      // and applied via @theme inline. So, direct extension here might be redundant
      // or could be used to give them Tailwind utility class names.
      // For simplicity, let's assume globals.css handles applying these to the theme for now.
      colors: {
        background: 'var(--background)',
        foreground: 'var(--foreground)',
        card: 'var(--card)',
        border: 'var(--border)',
        muted: 'var(--muted)',
        accent: 'var(--accent)',
        'accent-hover': 'var(--accent-hover)',
        error: 'var(--error)',
        'error-light': 'var(--error-light)',
      },
      fontFamily: {
        mono: ['var(--font-jetbrains-mono)', 'monospace'],
      },
    },
  },
  plugins: [
    // require('@tailwindcss/typography'), // We removed this earlier, prose styles are custom in globals.css
    // If you want official typography plugin, install and uncomment
  ],
} satisfies Config; 
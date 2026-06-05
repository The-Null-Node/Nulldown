import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// https://vitejs.dev/config/
export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  if (command === "build" && !env.VITE_PROVIDER_ENCRYPTION_PUBLIC_JWK) {
    throw new Error(
      "VITE_PROVIDER_ENCRYPTION_PUBLIC_JWK is required to build provider-escrow sharing.",
    );
  }

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
    server: {
      // Configure proxy for API requests during development (optional but good practice)
      // This assumes your Cloudflare functions will be available under /api/
      // For actual Cloudflare Pages deployment, this proxy is not needed.
      proxy: {
        "/api": {
          // If you run `wrangler pages dev ./dist` locally,
          // it might serve on http://localhost:8788 or similar.
          // Target that URL here.
          // For now, let's assume a placeholder or that you'll handle API calls directly.
          // target: 'http://localhost:8788', // Example: local wrangler dev server
          // changeOrigin: true,
          // rewrite: (path) => path.replace(/^\/api/, '') // if functions are at root of target
        },
      },
    },
  };
});

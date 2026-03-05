import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// All backend endpoints proxied so `src/` React app works via vite dev server too
const BACKEND = "http://localhost:3001";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      "/chat":     BACKEND,
      "/health":   BACKEND,
      "/tool":     BACKEND,
      "/test-db":  BACKEND,
      "/schema":   BACKEND,
    },
  },
});

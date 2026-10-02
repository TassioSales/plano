import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const api = "http://127.0.0.1:7676";

export default defineConfig({
  // PLANO_BASE lets the static build live under a sub-path (GitHub Pages).
  base: process.env.PLANO_BASE ?? "/",
  plugins: [react(), tailwindcss()],
  server: { port: 5176, proxy: { "/api": { target: api } } },
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 800 },
  test: { include: ["core/**/*.test.ts", "src/**/*.test.ts"], environment: "node" },
});

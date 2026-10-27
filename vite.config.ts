import { defineConfig } from "vitest/config";

// Tauri expects a fixed port and serves the built files from ui/dist.
export default defineConfig({
  root: "ui",
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
  test: { root: "ui", include: ["src/**/*.test.ts"] },
});

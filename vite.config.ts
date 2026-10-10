/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import pkg from "./package.json" with { type: "json" };

export default defineConfig({
  define: {
    __VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    target: "es2022",
    sourcemap: false,
    lib: {
      entry: "src/event-reel-card.ts",
      formats: ["es"],
      fileName: () => "event-reel-card.js",
    },
    rolldownOptions: {
      // HACS ships one file, so no extra chunks.
      output: { codeSplitting: false },
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});

/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import pkg from "./package.json" with { type: "json" };
import { bundledNotices, formatBanner } from "./build/third-party-notices.ts";

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
      // HACS ships one file, so no extra chunks. Library mode keeps whitespace in ES output
      // (for tree-shaking by consumers); this file is the end product, so minify it fully.
      // Minifying drops license comments, so the third-party notices go in after it.
      output: {
        codeSplitting: false,
        minify: true,
        postBanner: (chunk) =>
          formatBanner(
            `Event Reel Card ${pkg.version} (MIT). Bundled third-party code and its licenses:`,
            bundledNotices(chunk),
          ),
      },
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});

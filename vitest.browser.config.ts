import { defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";

// Browser smoke tests (test/ui): the card in a real Chromium on the harness's example data.
// `npm test` stays node-only; these run with `npm run test:ui`.
export default defineConfig({
  define: { __VERSION__: JSON.stringify("test") },
  test: {
    include: ["test/ui/**/*.test.ts"],
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: "chromium" }],
      viewport: { width: 1024, height: 900 },
    },
  },
});

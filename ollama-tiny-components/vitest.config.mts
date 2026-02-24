import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    // Tests are generated per-project in output/{id}/Component.test.tsx
    include: ["output/**/Component.test.tsx"],
    setupFiles: ["./vitest.setup.mts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});

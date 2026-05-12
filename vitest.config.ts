import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@src": resolve(__dirname, "src"),
      "@helpers": resolve(__dirname, "tests/_helpers"),
      "@fixtures": resolve(__dirname, "tests/_fixtures"),
    },
  },
  test: {
    environment: "node",
    include: [
      "src/**/*.{test,spec}.ts",
      "shared/**/*.{test,spec}.ts",
      "tests/unit/**/*.{test,spec}.ts",
      "tests/integration/**/*.{test,spec}.ts",
      "packages/electron/__tests__/**/*.{test,spec}.ts",
    ],
    exclude: [
      // Requires Electron build environment not present in this fork
      "packages/electron/__tests__/**/*",
      "tests/unit/ci/**/*",
      // Requires upstream adapter cache-token extraction (not yet synced)
      "tests/unit/proxy/upstream-cache-tokens.test.ts",
      // Script paths differ between fork and upstream
      "tests/unit/update-scripts-path.test.ts",
    ],
  },
});

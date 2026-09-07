import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", metrics: "src/journey/metrics.ts" },
  // Keep the optional entry independent: a shared metrics chunk becomes an
  // eager dependency when a host combines legacy imports with lazy metrics.
  splitting: false,
  dts: true,
  sourcemap: true,
  clean: true,
  format: ["esm", "cjs"],
  target: "es2022",
});

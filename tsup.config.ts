import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", metrics: "src/journey/metrics.ts" },
  splitting: true,
  dts: true,
  sourcemap: true,
  clean: true,
  format: ["esm", "cjs"],
  target: "es2022",
});

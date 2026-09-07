// @vitest-environment node
import { createRequire } from "node:module";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { projectUsefulMetric } from "../src/journey/metrics.js";

const require = createRequire(import.meta.url);

describe("published metric entry boundary", () => {
  it("exposes compatible standalone ESM and CJS projection exports", async () => {
    // Dynamic strings allow this test to fail at runtime before the new export exists.
    const entry = "@plasius/analytics/metrics";
    const esm = await import(entry);
    const cjs = require(entry);
    for (const module of [esm, cjs]) {
      expect(module.projectUsefulMetric({ metric: "page.load", value: 1234 }))
        .toEqual(projectUsefulMetric({ metric: "page.load", value: 1234 }));
      expect(Object.keys(module.USEFUL_METRIC_EVENT_DEFINITIONS)).toHaveLength(84);
      expect(module.createSemanticJourneyClient).toBeUndefined();
    }
  });

  it("does not retain metric initialization in a legacy-only host bundle", async () => {
    const result = await build({
      stdin: { contents: 'export { createFrontendAnalyticsClient } from "@plasius/analytics";', resolveDir: process.cwd() },
      bundle: true, write: false, format: "esm", platform: "browser", treeShaking: true,
    });
    expect(result.outputFiles[0]!.text).not.toMatch(/vital\.cls|episode\.active-duration|projectUsefulMetric/);
  });

  it("keeps the standalone metric bundle free of collectors, transport and React", async () => {
    const result = await build({
      stdin: { contents: 'export * from "@plasius/analytics/metrics";', resolveDir: process.cwd() },
      bundle: true, write: false, format: "esm", platform: "browser", minify: true,
    });
    const output = result.outputFiles[0]!.text;
    expect(output).not.toMatch(/fetch\(|addEventListener|XMLHttpRequest|react\.production|createSemanticJourneyClient/);
    expect(Buffer.byteLength(output)).toBeLessThan(5000);
  });
});

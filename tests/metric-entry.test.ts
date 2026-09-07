// @vitest-environment node
import { createRequire } from "node:module";
import { resolve } from "node:path";
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

  it("keeps metrics outside the initial graph when a legacy host loads them lazily", async () => {
    const result = await build({
      stdin: {
        contents: 'export { createFrontendAnalyticsClient } from "@plasius/analytics"; export const loadMetrics = () => import("@plasius/analytics/metrics");',
        resolveDir: process.cwd(),
      },
      bundle: true, write: false, format: "esm", platform: "browser",
      splitting: true, outdir: "virtual-bundle", metafile: true,
    });
    const outputs = result.metafile.outputs;
    const initial = Object.keys(outputs).filter(path => outputs[path]!.entryPoint === "<stdin>");
    expect(initial).toHaveLength(1);
    const visited = new Set<string>();
    while (initial.length > 0) {
      const path = initial.pop()!;
      if (visited.has(path)) continue;
      visited.add(path);
      const file = result.outputFiles.find(output => output.path === resolve(path));
      expect(file).toBeDefined();
      expect(file!.text).not.toMatch(/vital\.cls|episode\.active-duration|projectUsefulMetric/);
      initial.push(...outputs[path]!.imports
        .filter(dependency => !dependency.external && dependency.kind !== "dynamic-import")
        .map(dependency => dependency.path));
    }
    // The metric code must remain available in the deferred graph, not be removed.
    expect(result.outputFiles.some(file => /vital\.cls/.test(file.text))).toBe(true);
  });
});

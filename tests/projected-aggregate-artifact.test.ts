// @vitest-environment node
import { createRequire } from "node:module";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

describe("published projected aggregate boundary", () => {
  it("executes the same safe projection and validator in built ESM and CommonJS", async () => {
    const entry = "@plasius/analytics";
    const modules = [await import(entry), require(entry)];
    for (const api of modules) {
      const catalogue = api.defineSemanticJourneyCatalog({ "world.ready": { category: "state" } }, { sources: ["site"] });
      const binding = { source: "site", channel: "frontend", runtime: "browser" };
      const policy = api.defineSemanticJourneyAggregatePolicy(catalogue, { bindings: [binding] });
      const store = new api.ProjectedSemanticJourneyAggregateStore({ ...binding, policy });
      const now = Date.now();
      store.recordEvent({ name: "world.ready", category: "state", phase: "end", outcome: "success" }, now);
      const packet = store.createBatch({ batchId: "a".repeat(32), nowEpochMs: now, maxCounters: 50, maxBytes: 48 * 1024 });
      expect(packet.schemaVersion).toBe("2.1-aggregate");
      expect(api.createSemanticJourneyAggregateValidator(policy)(packet)).toBe(true);
      expect(api.createSemanticJourneyAggregateValidator(policy)({ ...packet, journeyId: "a".repeat(32) })).toBe(false);
    }
  });

  it("does not pull projected clients or validators into a legacy-only host", async () => {
    const result = await build({
      stdin: { contents: 'export { createFrontendAnalyticsClient } from "@plasius/analytics";', resolveDir: process.cwd() },
      bundle: true, write: false, format: "esm", platform: "browser", treeShaking: true,
    });
    expect(result.outputFiles[0]!.text).not.toMatch(/ProjectedSemanticJourneyAggregateStore|Semantic aggregate policy|2\.1-aggregate/);
  });
});

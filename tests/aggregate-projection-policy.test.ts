import { describe, expect, it } from "vitest";
import { defineSemanticJourneyCatalog } from "../src/journey/catalog.js";
import {
  defineSemanticJourneyAggregatePolicy,
  createSemanticJourneyAggregateValidator,
  projectSemanticJourneyAggregateCounters,
} from "../src/journey/aggregate-policy.js";

const catalogue = defineSemanticJourneyCatalog({
  "ui.control.activate": {
    category: "interaction",
    attributes: {
      screen: { type: "enum", values: ["home", "generator"] },
      action: { type: "enum", values: ["select", "retry"] },
      durationBucket: { type: "enum", values: ["short", "long"] },
      elapsed: { type: "number", min: 0, max: 1000 },
      ready: { type: "boolean" },
    },
  },
  "world.ready": { category: "state" },
}, { sources: ["plasius.site", "plasius.service"] });
const bindings = [
  { source: "plasius.site", channel: "frontend", runtime: "browser" },
  { source: "plasius.service", channel: "backend", runtime: "server" },
] as const;
const policy = defineSemanticJourneyAggregatePolicy(catalogue, {
  bindings,
  projections: { "ui.control.activate": { "screen-action": ["screen", "action"] } },
});
const input = {
  name: "ui.control.activate", category: "interaction", phase: "intent",
  outcome: "success", attributes: { screen: "home", action: "select", elapsed: 20 },
} as const;
function batch(projected = true) {
  return {
    schemaVersion: projected ? "2.1-aggregate" : "2.0-aggregate",
    batchId: "a".repeat(32), source: "plasius.site", channel: "frontend", runtime: "browser",
    timeBucket: "2026-09-08T10:00:00.000Z", policyVersion: "strict.v1", dropped: 0, coalesced: 0,
    counters: projected ? projectSemanticJourneyAggregateCounters(policy, input) : [
      { eventName: input.name, outcome: input.outcome, count: 1 },
    ],
  };
}

describe("catalogue-owned aggregate projections", () => {
  it("projects only declared finite dimensions and independent totals", () => {
    expect(projectSemanticJourneyAggregateCounters(policy, input, 2)).toEqual([
      { eventName: input.name, outcome: "success", count: 2, view: "total", dimensions: {} },
      { eventName: input.name, outcome: "success", count: 2, view: "screen-action",
        dimensions: { action: "select", screen: "home" } },
    ]);
    expect(JSON.stringify(projectSemanticJourneyAggregateCounters(policy, input)))
      .not.toMatch(/elapsed|attributes|journeyId|traceId|target/);
  });

  it("omits a view with missing dimensions without inventing values", () => {
    const rows = projectSemanticJourneyAggregateCounters(policy, { ...input, attributes: { screen: "home" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.view).toBe("total");
    expect(projectSemanticJourneyAggregateCounters(policy, {
      name: "world.ready", category: "state", phase: "end", outcome: "success",
    })).toEqual([{ eventName: "world.ready", outcome: "success", count: 1, view: "total", dimensions: {} }]);
  });

  it("copies and freezes policy definitions and projection rows", () => {
    const dimensions = ["screen"];
    const localBindings = [{ ...bindings[0] }];
    const localPolicy = defineSemanticJourneyAggregatePolicy(catalogue, {
      bindings: localBindings, projections: { "ui.control.activate": { surface: dimensions } },
    });
    dimensions.push("elapsed");
    localBindings[0]!.source = "plasius.service" as never;
    expect(localPolicy.bindings[0]?.source).toBe("plasius.site");
    expect(localPolicy.projections["ui.control.activate"]?.surface).toEqual(["screen"]);
    const rows = projectSemanticJourneyAggregateCounters(localPolicy, input);
    expect(() => { (rows[1]!.dimensions as Record<string, string>).screen = "generator"; }).toThrow();
    expect(() => { (localPolicy.projections as Record<string, unknown>).extra = {}; }).toThrow();
  });

  it.each([
    { bindings: [] },
    { bindings: [bindings[0], bindings[0]] },
    { bindings: [{ ...bindings[0], source: "unknown" }] },
    { bindings: [{ ...bindings[0], runtime: "server" }] },
    { bindings, extra: true },
    { bindings, projections: { "unknown.event": { surface: ["screen"] } } },
    { bindings, projections: { "ui.control.activate": { total: ["screen"] } } },
    { bindings, projections: { "ui.control.activate": { surface: ["screen", "screen"] } } },
    { bindings, projections: { "ui.control.activate": { surface: ["elapsed"] } } },
    { bindings, projections: { "ui.control.activate": { surface: ["ready"] } } },
    { bindings, projections: { "ui.control.activate": { surface: ["missing"] } } },
    { bindings, projections: { "ui.control.activate": { surface: [] } } },
    { bindings, projections: { "ui.control.activate": { email: ["screen"] } } },
  ])("rejects invalid or non-finite policy definitions without input reflection", (options) => {
    expect(() => defineSemanticJourneyAggregatePolicy(catalogue, options as never))
      .toThrow("Semantic aggregate policy is invalid.");
  });

  it("fails closed for private/unknown event data before projection", () => {
    for (const unsafe of [
      { ...input, attributes: { screen: "canary@example.invalid", action: "select" } },
      { ...input, attributes: { ...input.attributes, coordinate: 0.123 } },
      { ...input, journeyId: "a".repeat(32) },
      { ...input, name: "unknown.event" },
    ]) {
      expect(() => projectSemanticJourneyAggregateCounters(policy, unsafe as never))
        .toThrow("Semantic aggregate input is invalid.");
    }
    for (const count of [0, -1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => projectSemanticJourneyAggregateCounters(policy, input, count)).toThrow();
    }
  });
});

describe("shared aggregate ingress validator", () => {
  const validate = createSemanticJourneyAggregateValidator(policy);

  it("accepts strict 2.0 and 2.1 for exact registered producer bindings", () => {
    expect(validate(batch())).toBe(true);
    expect(validate(batch(false))).toBe(true);
    expect(validate({ ...batch(), ...bindings[1] })).toBe(true);
    expect(validate({ ...batch(), source: "plasius.service" })).toBe(false);
    expect(validate({ ...batch(), counters: [] })).toBe(true);
  });

  it.each([
    ["schemaVersion", "1.0"], ["batchId", "0".repeat(32)], ["batchId", "x".repeat(32)],
    ["source", "unregistered"], ["channel", "other"], ["runtime", "other"],
    ["timeBucket", "2026-02-31T10:00:00.000Z"], ["timeBucket", "2026-09-08T10:00:01.000Z"],
    ["policyVersion", "unsafe"], ["dropped", -1], ["coalesced", 0.1],
    ["journeyId", "a".repeat(32)], ["url", "https://private.example.invalid"],
    ["requestId", "test"], ["context", {}],
  ])("rejects an invalid or unknown envelope field %s", (field, value) => {
    expect(validate({ ...batch(), [field]: value })).toBe(false);
  });

  it("rejects unknown, incomplete, duplicate or private counter projections", () => {
    const row = batch().counters[1]!;
    for (const counter of [
      { ...row, dimensions: { screen: "home" } },
      { ...row, dimensions: { screen: "home", action: "select", durationBucket: "short" } },
      { ...row, dimensions: { screen: "https://private.example.invalid", action: "select" } },
      { ...row, view: "unregistered" }, { ...row, view: "total" },
      { ...row, eventName: "world.ready" }, { ...row, outcome: "rejected" },
      { ...row, count: 0 }, { ...row, count: Number.MAX_SAFE_INTEGER + 1 },
      { ...row, eventId: "a".repeat(32) },
    ]) expect(validate({ ...batch(), counters: [counter] })).toBe(false);
    expect(validate({ ...batch(), counters: [row, row] })).toBe(false);
    expect(validate({ ...batch(false), counters: [row] })).toBe(false);
    expect(validate({ ...batch(), counters: batch(false).counters })).toBe(false);
  });

  it("rejects malformed objects and does not invoke getters or serialization hooks", () => {
    let read = false;
    const accessor = { ...batch(), get source() { read = true; return "plasius.site"; } };
    for (const invalid of [null, [], "text", accessor, { ...batch(), toJSON() { read = true; return {}; } },
      Object.assign(Object.create({ private: "data" }), batch()),
      { ...batch(), [Symbol("private")]: "data" },
    ]) expect(validate(invalid)).toBe(false);
    expect(read).toBe(false);
  });

  it("bounds row traversal and serialized bytes", () => {
    expect(validate({ ...batch(), counters: Array(501).fill(batch().counters[0]) })).toBe(false);
    expect(validate({ ...batch(), counters: [{ ...batch().counters[0], dimensions: "x".repeat(70000) }] })).toBe(false);
  });

  it("rejects a structurally valid finite packet exceeding the 64-KiB wire ceiling", () => {
    const values = Array.from({ length: 32 }, (_, i) => `surface.descriptive-choice.${i}`);
    const largeCatalogue = defineSemanticJourneyCatalog({ "world.select": {
      category: "interaction", attributes: {
        first: { type: "enum", values }, second: { type: "enum", values },
      },
    } }, { sources: ["plasius.site"] });
    const largePolicy = defineSemanticJourneyAggregatePolicy(largeCatalogue, {
      bindings: [bindings[0]], projections: { "world.select": { combined: ["first", "second"] } },
    });
    const counters = Array.from({ length: 500 }, (_, i) => ({
      eventName: "world.select", outcome: "success", count: 1, view: "combined",
      dimensions: { first: values[Math.floor(i / 32)]!, second: values[i % 32]! },
    }));
    const large = { ...batch(), counters };
    expect(new TextEncoder().encode(JSON.stringify(large)).length).toBeGreaterThan(64 * 1024);
    expect(createSemanticJourneyAggregateValidator(largePolicy)(large)).toBe(false);
    expect(createSemanticJourneyAggregateValidator(largePolicy)({ ...large, counters: counters.slice(0, 10) })).toBe(true);
  });
});

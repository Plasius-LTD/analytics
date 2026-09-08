import { describe, expect, it } from "vitest";
import { defineSemanticJourneyCatalog } from "../src/journey/catalog.js";
import { defineSemanticJourneyAggregatePolicy, createSemanticJourneyAggregateValidator } from "../src/journey/aggregate-policy.js";
import { ProjectedSemanticJourneyAggregateStore } from "../src/journey/projected-aggregate-store.js";

const catalogue = defineSemanticJourneyCatalog({
  "ui.control.activate": { category: "interaction", attributes: {
    screen: { type: "enum", values: ["home", "generator", "preview"] },
  } },
}, { sources: ["plasius.site"] });
const binding = { source: "plasius.site", channel: "frontend", runtime: "browser" } as const;
const policy = defineSemanticJourneyAggregatePolicy(catalogue, {
  bindings: [binding], projections: { "ui.control.activate": { surface: ["screen"] } },
});
const event = { name: "ui.control.activate", category: "interaction", phase: "intent", outcome: "success", attributes: { screen: "home" } } as const;
const start = Date.parse("2026-09-08T10:59:30.000Z");
const options = { batchId: "a".repeat(32), nowEpochMs: start, maxCounters: 50, maxBytes: 48 * 1024 };
const storeOptions = { policy, ...binding, now: () => start };

describe("projected aggregate store", () => {
  it("retains original observation hours across rollover and delayed flush", () => {
    const store = new ProjectedSemanticJourneyAggregateStore(storeOptions);
    store.recordEvent(event, start);
    store.recordEvent(event, start + 60_000);
    const first = store.createBatch({ ...options, nowEpochMs: start + 120_000 });
    expect(first?.timeBucket).toBe("2026-09-08T10:00:00.000Z");
    expect(first?.counters.map((row) => row.count)).toEqual([1, 1]);
    expect(createSemanticJourneyAggregateValidator(policy)(first)).toBe(true);
    store.acknowledge(first!);
    const second = store.createBatch({ ...options, batchId: "b".repeat(32), nowEpochMs: start + 120_000 });
    expect(second?.timeBucket).toBe("2026-09-08T11:00:00.000Z");
  });

  it("retains one immutable retry snapshot and acknowledges it only once", () => {
    const store = new ProjectedSemanticJourneyAggregateStore(storeOptions);
    store.recordEvent(event, start);
    const batch = store.createBatch(options)!;
    store.recordEvent(event, start + 1);
    expect(store.createBatch({ ...options, batchId: "b".repeat(32) })).toBe(batch);
    expect(store.isPendingBatch(batch, start + 1)).toBe(true);
    store.acknowledge({ ...batch });
    expect(store.snapshot().counters.map((row) => row.count)).toEqual([2, 2]);
    store.acknowledge(batch);
    store.acknowledge(batch);
    expect(store.snapshot().counters.map((row) => row.count)).toEqual([1, 1]);
  });

  it("does not refresh expiry when a counter receives newer observations", () => {
    const store = new ProjectedSemanticJourneyAggregateStore({ ...storeOptions, maxAgeMs: 1000 });
    store.recordEvent(event, start);
    const batch = store.createBatch(options)!;
    store.recordEvent(event, start + 500);
    expect(store.isPendingBatch(batch, start + 1000)).toBe(false);
    expect(store.snapshot().counters).toEqual([]);
    expect(store.snapshot().dropped).toBe(2);
  });

  it("expires an hour consistently across totals and views, including a newer partial retry", () => {
    const store = new ProjectedSemanticJourneyAggregateStore({ ...storeOptions, maxAgeMs: 1000 });
    store.recordEvent(event, start);
    store.recordEvent({ ...event, attributes: { screen: "generator" } }, start + 500);
    const newerView = store.createBatch({ ...options, nowEpochMs: start + 500, maxCounters: 1 })!;
    expect(newerView.counters[0]?.dimensions.screen).toBe("generator");
    expect(store.isPendingBatch(newerView, start + 1000)).toBe(false);
    expect(store.snapshot().counters).toEqual([]);
    store.recordEvent(event, start + 1001);
    store.acknowledge(newerView);
    expect(store.snapshot().counters.map((row) => row.count)).toEqual([1, 1]);
  });

  it("bounds counters and accounts for dropped observations without partial projections", () => {
    const store = new ProjectedSemanticJourneyAggregateStore({ ...storeOptions, maxPendingCounters: 2 });
    expect(store.recordEvent(event, start)).toBe(true);
    expect(store.recordEvent({ ...event, attributes: { screen: "generator" } }, start)).toBe(false);
    expect(store.snapshot().counters.map((row) => row.count)).toEqual([1, 1]);
    expect(store.snapshot().dropped).toBe(1);
    expect(store.snapshot().pendingCounters).toBe(2);
  });

  it("bounds bytes even when the row limit has spare capacity", () => {
    const store = new ProjectedSemanticJourneyAggregateStore({ ...storeOptions, maxPendingBytes: 512 });
    for (const screen of ["home", "generator", "preview"]) store.recordEvent({ ...event, attributes: { screen } }, start);
    expect(store.snapshot().pendingBytes).toBeLessThanOrEqual(512);
    expect(store.snapshot().dropped).toBeGreaterThan(0);
  });

  it("splits by count/bytes and preserves diagnostic counts during acknowledgements", () => {
    const store = new ProjectedSemanticJourneyAggregateStore(storeOptions);
    store.recordEvent(event, start);
    store.recordDropped(2);
    store.recordCoalesced(3);
    const batch = store.createBatch({ ...options, maxCounters: 1, maxBytes: 512 })!;
    expect(batch.counters).toHaveLength(1);
    expect(new TextEncoder().encode(JSON.stringify(batch)).length).toBeLessThanOrEqual(512);
    store.recordDropped();
    store.acknowledge(batch);
    expect(store.snapshot()).toMatchObject({ dropped: 1, coalesced: 0, pendingCounters: 1 });
  });

  it("clear discards retry state and stale acknowledgements cannot change new data", () => {
    const store = new ProjectedSemanticJourneyAggregateStore(storeOptions);
    store.recordEvent(event, start);
    const old = store.createBatch(options)!;
    store.clear();
    store.recordEvent(event, start + 1);
    store.acknowledge(old);
    expect(store.snapshot().counters.map((row) => row.count)).toEqual([1, 1]);
    store.clear();
    expect(store.createBatch(options)).toBeNull();
    expect(store.snapshot().pendingBytes).toBe(0);
  });

  it("fails atomically on overflow and invalid input", () => {
    const store = new ProjectedSemanticJourneyAggregateStore(storeOptions);
    store.recordEvent(event, start, Number.MAX_SAFE_INTEGER);
    expect(() => store.recordEvent(event, start)).toThrow("Semantic aggregate input is invalid.");
    expect(store.snapshot().counters.every((row) => row.count === Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(() => store.recordEvent(event, NaN)).toThrow();
    expect(() => store.recordEvent(event, Date.parse("+010000-01-01T00:00:00.000Z"))).toThrow();
    expect(() => store.recordEvent({ ...event, attributes: { screen: "canary@example.invalid" } }, start)).toThrow();
    expect(() => store.createBatch({ ...options, batchId: "bad" })).toThrow();
    expect(() => new ProjectedSemanticJourneyAggregateStore({ ...storeOptions, source: "other" })).toThrow();
    expect(() => new ProjectedSemanticJourneyAggregateStore({ ...storeOptions, maxPendingCounters: 5001 })).toThrow();
  });
});

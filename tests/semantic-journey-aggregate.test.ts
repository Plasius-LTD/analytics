import { describe, expect, it } from "vitest";

import { SemanticJourneyAggregateStore } from "../src/journey/aggregate.js";
import { defineSemanticJourneyCatalog } from "../src/journey/catalog.js";
import type { SemanticJourneyEventDefinition } from "../src/journey/types.js";

const definitions: Record<string, SemanticJourneyEventDefinition> = {
  "checkout.submit": { category: "interaction" },
  "alpha.open": { category: "state" },
  "beta.open": { category: "state" },
  "gamma.open": { category: "state" },
};
for (let index = 0; index < 20; index += 1) {
  definitions[`bounded.event-${index}`] = { category: "state" };
}
const catalogue = defineSemanticJourneyCatalog(
  definitions,
  { sources: ["plasius.site"] }
);

function createStore(): SemanticJourneyAggregateStore {
  return new SemanticJourneyAggregateStore({
    catalogue,
    source: "plasius.site",
    channel: "frontend",
    runtime: "browser",
  });
}

describe("SemanticJourneyAggregateStore", () => {
  it("coarsens time and never accepts individual journey identifiers", () => {
    const store = createStore();
    store.record("checkout.submit", "success", 2);
    store.recordDropped();
    store.recordCoalesced(3);

    const batch = store.createBatch({
      batchId: "a".repeat(32),
      nowEpochMs: Date.parse("2026-07-11T10:34:56.789Z"),
      maxCounters: 50,
      maxBytes: 48 * 1024,
    });

    expect(batch).toEqual({
      schemaVersion: "2.0-aggregate",
      batchId: "a".repeat(32),
      source: "plasius.site",
      channel: "frontend",
      runtime: "browser",
      timeBucket: "2026-07-11T10:00:00.000Z",
      policyVersion: "strict.v1",
      dropped: 1,
      coalesced: 3,
      counters: [
        { eventName: "checkout.submit", outcome: "success", count: 2 },
      ],
    });
    expect(JSON.stringify(batch)).not.toMatch(
      /journeyId|traceId|eventId|producerId|sessionId|userAgent|ipHash|identityHash/,
    );
  });

  it("acknowledges only the sent snapshot and preserves concurrently added counts", () => {
    const store = createStore();
    store.record("checkout.submit", "success", 2);
    const batch = store.createBatch({
      batchId: "b".repeat(32),
      nowEpochMs: 1_700_000_000_000,
      maxCounters: 50,
      maxBytes: 48 * 1024,
    });
    expect(batch).not.toBeNull();

    store.record("checkout.submit", "success", 3);
    store.acknowledge(batch!);

    expect(store.snapshot().counters).toEqual([
      { eventName: "checkout.submit", outcome: "success", count: 3 },
    ]);
  });

  it("does not expose mutable counter references through snapshots or batches", () => {
    const store = createStore();
    store.record("checkout.submit", "success");
    const snapshot = store.snapshot();
    const batch = store.createBatch({
      batchId: "e".repeat(32),
      nowEpochMs: 1_700_000_000_000,
      maxCounters: 50,
      maxBytes: 48 * 1024,
    });

    expect(() => {
      (snapshot.counters[0] as { eventName: string }).eventName = "other.event";
    }).toThrow();
    expect(() => {
      (batch?.counters as unknown as unknown[]).push({});
    }).toThrow();
    expect(store.snapshot().counters[0]?.eventName).toBe("checkout.submit");
  });

  it("splits counters by count and UTF-8 byte limits", () => {
    const store = createStore();
    store.record("alpha.open", "success");
    store.record("beta.open", "success");
    store.record("gamma.open", "success");

    const countBound = store.createBatch({
      batchId: "c".repeat(32),
      nowEpochMs: 1_700_000_000_000,
      maxCounters: 2,
      maxBytes: 48 * 1024,
    });
    expect(countBound?.counters).toHaveLength(2);

    for (let index = 0; index < 20; index += 1) {
      store.record(`bounded.event-${index}`, "success");
    }
    const byteBound = store.createBatch({
      batchId: "c".repeat(32),
      nowEpochMs: 1_700_000_000_000,
      maxCounters: 50,
      maxBytes: 512,
    });
    expect(byteBound?.counters.length).toBeGreaterThan(0);
    expect(byteBound?.counters.length).toBeLessThan(23);
    expect(new TextEncoder().encode(JSON.stringify(byteBound)).byteLength).toBeLessThanOrEqual(512);
  });

  it("returns no batch when no aggregate evidence exists", () => {
    expect(createStore().createBatch({
      batchId: "d".repeat(32),
      nowEpochMs: 1_700_000_000_000,
      maxCounters: 50,
      maxBytes: 48 * 1024,
    })).toBeNull();
  });

  it("rejects unsafe wire dimensions without reflecting their values", () => {
    const canary = "canary.person@example.invalid";
    let thrown: unknown;
    try {
      const store = createStore();
      store.record(canary, "success");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(String(thrown)).not.toContain(canary);
    expect(() => createStore().record("alice-synthetic", "success"))
      .toThrow("semantic journey aggregate input is invalid");
    expect(() => new SemanticJourneyAggregateStore({
      catalogue,
      source: "alice-synthetic",
      channel: "frontend",
      runtime: "browser",
    })).toThrow("semantic journey aggregate input is invalid");
    expect(() => createStore().record("checkout.submit", "other" as never))
      .toThrow("semantic journey aggregate input is invalid");
    expect(() => createStore().record(
      "checkout.submit",
      "success",
      Number.MAX_SAFE_INTEGER + 1,
    )).toThrow("semantic journey aggregate counter increment is invalid");
    expect(() => createStore().createBatch({
      batchId: "not-an-id",
      nowEpochMs: 1_700_000_000_000,
      maxCounters: 50,
      maxBytes: 48 * 1024,
    })).toThrow("semantic journey aggregate input is invalid");
  });
});

import { describe, expect, it, vi } from "vitest";
import { defineSemanticJourneyCatalog } from "../src/journey/catalog.js";
import { createSemanticJourneyClient, type SemanticJourneyClientConfig } from "../src/journey/client.js";
import { defineSemanticJourneyAggregatePolicy, createSemanticJourneyAggregateValidator } from "../src/journey/aggregate-policy.js";
import type { SemanticJourneyAggregateTransportRequest } from "../src/journey/transport.js";

const catalogue = defineSemanticJourneyCatalog({ "ui.control.activate": {
  category: "interaction", attributes: { screen: { type: "enum", values: ["home", "generator"] } },
} }, { sources: ["plasius.site"] });
const policy = defineSemanticJourneyAggregatePolicy(catalogue, {
  bindings: [{ source: "plasius.site", channel: "frontend", runtime: "browser" }],
  projections: { "ui.control.activate": { surface: ["screen"] } },
});
const event = { name: "ui.control.activate", category: "interaction", phase: "intent", outcome: "success", attributes: { screen: "home" } } as const;
function config(extra: Partial<SemanticJourneyClientConfig> = {}): SemanticJourneyClientConfig {
  return { catalogue, aggregatePolicy: policy, source: "plasius.site", channel: "frontend", runtime: "browser", enabled: true,
    autoFlush: false, aggregateEndpoint: "/api/analytics/semantic-aggregates", maxBatchesPerFlush: 2, ...extra };
}

describe("opt-in projected shared client", () => {
  it("sends reviewed projections through the existing transport without local identifiers", async () => {
    const bodies: string[] = [];
    const client = createSemanticJourneyClient(config({ aggregateTransport: async ({ body }) => { bodies.push(body); } }));
    const local = client.track(event)!;
    await client.flush();
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0]!)).toMatchObject({ schemaVersion: "2.1-aggregate" });
    expect(createSemanticJourneyAggregateValidator(policy)(JSON.parse(bodies[0]!))).toBe(true);
    expect(JSON.parse(bodies[0]!).counters).toEqual(expect.arrayContaining([
      { eventName: event.name, outcome: "success", count: 1, view: "surface", dimensions: { screen: "home" } },
    ]));
    for (const id of [local.eventId, local.journeyId, local.traceId, local.spanId, local.producerId]) expect(bodies[0]).not.toContain(id);
    client.destroy();
  });

  it("retries the same original-hour payload and never sends it after local expiry", async () => {
    let now = Date.parse("2026-09-08T10:59:59.000Z");
    const bodies: string[] = [];
    const client = createSemanticJourneyClient(config({ now: () => now, maxEventAgeMs: 5000, maxRetries: 0,
      aggregateTransport: async ({ body }) => { bodies.push(body); throw new Error("unavailable"); } }));
    client.track(event);
    await client.flush();
    now += 2000;
    await client.flush();
    expect(bodies[1]).toBe(bodies[0]);
    expect(JSON.parse(bodies[1]!).timeBucket).toBe("2026-09-08T10:00:00.000Z");
    now += 5000;
    await client.flush();
    expect(bodies.slice(2).every((body) => JSON.parse(body).counters.length === 0)).toBe(true);
    client.destroy();
  });

  it("does not retry an expired snapshot after a retry delay", async () => {
    let now = 1000;
    const transport = vi.fn(async (_request: SemanticJourneyAggregateTransportRequest) => { throw new Error("offline"); });
    const client = createSemanticJourneyClient(config({ now: () => now, maxEventAgeMs: 10, aggregateTransport: transport,
      retryDelay: async () => { now += 100; } }));
    client.track(event);
    await client.flush();
    // A diagnostic-only packet may follow, but original event rows are sent once.
    expect(transport.mock.calls.filter(([request]) => JSON.parse(request.body).counters.length > 0)).toHaveLength(1);
    expect(transport.mock.calls.length).toBeLessThanOrEqual(2);
    client.destroy();
  });

  it("remains opt-in and discard-only during withdrawal including a delayed completion", async () => {
    const transport = vi.fn(async () => undefined);
    const disabled = createSemanticJourneyClient(config({ enabled: false, aggregateTransport: transport }));
    expect(disabled.track(event)).toBeUndefined();
    await disabled.flush();
    expect(transport).not.toHaveBeenCalled();
    disabled.destroy();
    let complete!: () => void;
    let signal: AbortSignal | undefined;
    const client = createSemanticJourneyClient(config({ aggregateTransport: async (request) => {
      signal = request.signal; await new Promise<void>((resolve) => { complete = resolve; });
    } }));
    client.track(event);
    const flush = client.flush();
    client.destroy();
    expect(signal?.aborted).toBe(true);
    complete();
    await flush;
    expect(client.getEvents()).toEqual([]);
    expect(client.track(event)).toBeUndefined();
  });

  it("rejects a forged/mismatched policy or producer binding before capture", () => {
    expect(() => createSemanticJourneyClient(config({ aggregatePolicy: { ...policy } }))).toThrow();
    expect(() => createSemanticJourneyClient(config({ channel: "backend", runtime: "server" }))).toThrow();
    const other = defineSemanticJourneyCatalog({ other: { category: "state" } }, { sources: ["plasius.site"] });
    expect(() => createSemanticJourneyClient(config({ catalogue: other }))).toThrow();
  });

  it("defaults projected delivery to at most two batches per flush", async () => {
    const transport = vi.fn(async (_request: SemanticJourneyAggregateTransportRequest) => undefined);
    const client = createSemanticJourneyClient(config({ aggregateTransport: transport,
      aggregateMaxCounters: 1, maxBatchesPerFlush: undefined }));
    client.track(event);
    client.track({ ...event, attributes: { screen: "generator" } });
    await client.flush();
    expect(transport).toHaveBeenCalledTimes(2);
    await client.flush();
    expect(transport).toHaveBeenCalledTimes(3);
    client.destroy();
  });
});

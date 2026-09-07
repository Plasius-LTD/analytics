import { describe, expect, it, vi } from "vitest";
import {
  USEFUL_METRIC_EVENT_DEFINITIONS,
  projectUsefulMetric,
  createSemanticJourneyClient,
  defineSemanticJourneyCatalog,
  validateSemanticJourneyEventInput,
} from "../src/index.js";

const catalogue = () => defineSemanticJourneyCatalog(
  USEFUL_METRIC_EVENT_DEFINITIONS, { sources: ["plasius.site"] },
);

describe("useful metric privacy projection", () => {
  it.each([
    [0, "lt100ms"], [99.9, "lt100ms"], [100, "lt250ms"],
    [250, "lt500ms"], [500, "lt1000ms"], [1000, "lt2500ms"],
    [2500, "lt5000ms"], [5000, "lt10000ms"], [10000, "gte10000ms"],
    [86_400_000, "gte10000ms"],
  ])("buckets duration %s before creating an event", (value, bucket) => {
    expect(projectUsefulMetric({ metric: "page.load", value })).toEqual({
      name: `metric.page.load.${bucket}`, category: "presentation",
      phase: "end", outcome: "unknown", modality: "system",
    });
  });

  it.each(["page.load", "route.ready", "world.ready", "request.duration", "vital.lcp", "vital.fcp", "vital.inp", "vital.ttfb"])(
    "registers and validates %s", (metric) => {
      const event = projectUsefulMetric({ metric, value: 250 });
      expect(event).not.toBeNull();
      expect(() => validateSemanticJourneyEventInput(catalogue(), event!)).not.toThrow();
    },
  );

  it.each([[0, "lt01"], [0.099, "lt01"], [0.1, "lt025"], [0.25, "gte025"], [100, "gte025"]])(
    "uses unitless layout-shift buckets for %s", (value, bucket) => {
      expect(projectUsefulMetric({ metric: "vital.cls", value })?.name)
        .toBe(`metric.vital.cls.${bucket}`);
    },
  );

  it.each([[0, "lt10s"], [10000, "lt60s"], [60000, "lt300s"], [300000, "lt900s"], [900000, "lt3600s"], [3600000, "gte3600s"]])(
    "buckets anonymous active duration %s", (value, bucket) => {
      expect(projectUsefulMetric({ metric: "episode.active-duration", value })?.name)
        .toBe(`metric.episode.active-duration.${bucket}`);
    },
  );

  it.each([
    ["episode.started", "unknown"], ["episode.completed", "unknown"],
    ["request.started", "unknown"], ["request.completed", "success"],
    ["request.failed", "failure"], ["request.cancelled", "cancelled"],
    ["request.rejected", "denied"], ["error.runtime", "failure"],
    ["error.resource", "failure"], ["error.render", "failure"],
    ["error.unhandled", "failure"],
  ])("projects one fixed %s observation", (metric, outcome) => {
    const event = projectUsefulMetric({ metric });
    expect(event?.name).toBe(`metric.${metric}`);
    expect(event?.outcome).toBe(outcome);
    expect(() => validateSemanticJourneyEventInput(catalogue(), event!)).not.toThrow();
  });

  it.each([
    undefined, null, [], "page.load", new Date(),
    {}, { metric: "not.registered", value: 1 }, { metric: "toString" },
    { metric: "page.load" }, { metric: "page.load", value: "100" },
    { metric: "page.load", value: -1 }, { metric: "page.load", value: NaN },
    { metric: "page.load", value: Infinity }, { metric: "page.load", value: 86_400_001 },
    { metric: "vital.cls", value: 101 }, { metric: "episode.started", value: 1 },
  ])("rejects malformed samples without coercion: %j", (input) => {
    expect(projectUsefulMetric(input)).toBeNull();
  });

  it("rejects all extra fields rather than laundering legacy NFR payloads", () => {
    const canary = "synthetic.person@example.invalid";
    for (const key of ["props", "url", "label", "text", "stack", "error", "sessionId", "valueOf", "ts", "coordinates", "attributes"]) {
      expect(projectUsefulMetric({ metric: "page.load", value: 12, [key]: canary })).toBeNull();
    }
    expect(projectUsefulMetric({ metric: "page.load", value: 12, [Symbol("private")]: canary })).toBeNull();
  });

  it("does not invoke accessors or expose hostile-object errors", () => {
    const getter = vi.fn(() => { throw new Error("synthetic-private-canary"); });
    expect(projectUsefulMetric(Object.defineProperty({ value: 2 }, "metric", { get: getter }))).toBeNull();
    expect(projectUsefulMetric(Object.defineProperty({ metric: "page.load" }, "value", { get: getter }))).toBeNull();
    expect(getter).not.toHaveBeenCalled();
    expect(projectUsefulMetric(new Proxy({}, { ownKeys: getter }))).toBeNull();
    expect(projectUsefulMetric(Object.create({ metric: "page.load", value: 10 }))).toBeNull();
    expect(projectUsefulMetric(Object.assign(Object.create(null), { metric: "page.load", value: 10 }))).not.toBeNull();
  });

  it("exports an immutable bounded catalogue without arbitrary dimensions", () => {
    expect(Object.keys(USEFUL_METRIC_EVENT_DEFINITIONS)).toHaveLength(84);
    expect(Object.isFrozen(USEFUL_METRIC_EVENT_DEFINITIONS)).toBe(true);
    for (const definition of Object.values(USEFUL_METRIC_EVENT_DEFINITIONS)) {
      expect(Object.isFrozen(definition)).toBe(true);
      expect(Object.keys(definition)).toEqual(["category"]);
    }
  });

  it("preserves histogram buckets in the real aggregate wire payload", async () => {
    const bodies: string[] = [];
    const client = createSemanticJourneyClient({
      catalogue: catalogue(), source: "plasius.site", enabled: true,
      aggregateEndpoint: "/api/analytics/semantic-aggregates", autoFlush: false,
      aggregateTransport: async (request) => { bodies.push(request.body); },
    });
    for (const value of [123.456, 125.678, 250]) {
      client.track(projectUsefulMetric({ metric: "page.load", value })!);
    }
    client.track(projectUsefulMetric({ metric: "episode.started" })!);
    client.track(projectUsefulMetric({ metric: "error.runtime" })!);
    await client.flush();
    const counters = bodies.flatMap(body => JSON.parse(body).counters);
    expect(counters).toEqual(expect.arrayContaining([
      { eventName: "metric.page.load.lt250ms", outcome: "unknown", count: 2 },
      { eventName: "metric.page.load.lt500ms", outcome: "unknown", count: 1 },
      { eventName: "metric.episode.started", outcome: "unknown", count: 1 },
      { eventName: "metric.error.runtime", outcome: "failure", count: 1 },
    ]));
    expect(bodies.join("")).not.toMatch(/123\.456|125\.678|journeyId|sessionId|traceId|eventId|attributes|stack|coordinates/);
    client.destroy();
  });

  it("adds no transport or capture side effects when the host is disabled", async () => {
    const transport = vi.fn();
    const client = createSemanticJourneyClient({
      catalogue: catalogue(), source: "plasius.site", enabled: false,
      aggregateEndpoint: "/api/analytics/semantic-aggregates", aggregateTransport: transport,
    });
    for (let i = 0; i < 10000; i += 1) {
      client.track(projectUsefulMetric({ metric: "page.load", value: i })!);
    }
    expect(client.getEvents()).toEqual([]);
    await client.flush();
    expect(transport).not.toHaveBeenCalled();
    client.destroy();
  });
});

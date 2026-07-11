import { describe, expect, it, vi } from "vitest";
import { defineSemanticJourneyCatalog } from "../src/journey/catalog.js";
import {
  createSemanticJourneyClient,
  type SemanticJourneyClientConfig,
} from "../src/journey/client.js";
import type { RandomByteSource } from "../src/journey/context.js";
import {
  serializeSemanticJourneyReceipts,
  type SemanticJourneyConsequenceReceipt,
} from "../src/journey/receipt.js";
import {
  SemanticJourneyTransportError,
  type SemanticJourneyAggregateTransportRequest,
} from "../src/journey/transport.js";

const catalogue = defineSemanticJourneyCatalog({
  "checkout.submit": {
    category: "interaction",
    attributes: {
      validationState: {
        type: "enum",
        values: ["valid", "invalid", "unknown"],
      },
    },
  },
  "checkout.create": { category: "request" },
  "order.create": {
    category: "command",
    effects: ["policy-denied", "order-accepted"],
  },
  "media.progress": {
    category: "state",
    targets: [{ type: "media", id: "primary" }],
  },
}, { sources: ["site"] });

function secureCounterBytes(): RandomByteSource {
  let counter = 1;
  return (byteLength) => {
    const bytes = new Uint8Array(byteLength);
    for (let index = 0; index < byteLength; index += 1) {
      bytes[index] = ((counter + index) % 254) + 1;
    }
    counter += 1;
    return bytes;
  };
}

function clientConfig(
  overrides: Partial<SemanticJourneyClientConfig> = {}
): SemanticJourneyClientConfig {
  return {
    catalogue,
    source: "site",
    channel: "frontend",
    runtime: "browser",
    enabled: true,
    autoFlush: false,
    randomBytes: secureCounterBytes(),
    ...overrides,
  };
}

function submitInput() {
  return {
    name: "checkout.submit",
    category: "interaction" as const,
    phase: "intent" as const,
    outcome: "unknown" as const,
    modality: "keyboard" as const,
    attributes: { validationState: "valid" },
  };
}

describe("createSemanticJourneyClient", () => {
  it("defaults to disabled and records no semantic evidence", async () => {
    const transport = vi.fn(async () => undefined);
    const client = createSemanticJourneyClient({
      catalogue,
      source: "site",
      aggregateEndpoint: "/api/analytics/semantic-aggregates",
      aggregateTransport: transport,
      autoFlush: false,
    });

    expect(client.track(submitInput())).toBeUndefined();
    expect(client.beginRequest({
      name: "checkout.create",
      category: "request",
      phase: "start",
      outcome: "unknown",
    })).toBeUndefined();
    expect(client.getEvents()).toEqual([]);
    await client.flush();
    expect(transport).not.toHaveBeenCalled();
  });

  it("retains strict individual evidence only in memory and uploads aggregates", async () => {
    const bodies: string[] = [];
    const client = createSemanticJourneyClient(clientConfig({
      aggregateEndpoint: "/api/analytics/semantic-aggregates",
      aggregateTransport: async ({ body }) => {
        bodies.push(body);
      },
    }));

    const event = client.track(submitInput());
    expect(event).toEqual(expect.objectContaining({
      schemaVersion: "2.0",
      source: "site",
      name: "checkout.submit",
      producerSequence: 1,
      privacy: {
        mode: "strict",
        policyVersion: "strict.v1",
        droppedAttributeCount: 0,
      },
    }));
    expect(client.getEvents()).toHaveLength(1);

    await client.flush();

    expect(bodies).toHaveLength(1);
    const body = bodies[0] ?? "";
    expect(JSON.parse(body)).toEqual(expect.objectContaining({
      schemaVersion: "2.0-aggregate",
      source: "site",
      dropped: 0,
      coalesced: 0,
      counters: [
        { eventName: "checkout.submit", outcome: "unknown", count: 1 },
      ],
    }));
    expect(body).not.toContain("journeyId");
    expect(body).not.toContain("traceId");
    expect(body).not.toContain("eventId");
    expect(body).not.toContain("producerId");
    expect(body).not.toContain("validationState");
    expect(body).not.toContain(event?.journeyId ?? "missing-event");
    client.destroy();
  });

  it("fails closed without reflecting rejected content", () => {
    const drops: string[] = [];
    const client = createSemanticJourneyClient(clientConfig({
      onDrop: (reason) => drops.push(reason),
    }));
    const privateCanary = "canary.person@example.invalid";

    const event = client.track({
      ...submitInput(),
      attributes: {
        validationState: "valid",
        email: privateCanary,
      },
    });

    expect(event).toBeUndefined();
    expect(client.getEvents()).toEqual([]);
    expect(drops).toEqual(["invalid"]);
    expect(JSON.stringify(drops)).not.toContain(privateCanary);
    client.destroy();
  });

  it("coalesces bounded progress evidence while preserving aggregate counts", async () => {
    let body = "";
    let now = 1_000;
    const client = createSemanticJourneyClient(clientConfig({
      now: () => now,
      coalesceWindowMs: 1_000,
      aggregateEndpoint: "/api/analytics/semantic-aggregates",
      aggregateTransport: async (request) => {
        body = request.body;
      },
    }));
    const progress = {
      name: "media.progress",
      category: "state" as const,
      phase: "progress" as const,
      outcome: "success" as const,
      target: { type: "media", id: "primary" },
    };

    expect(client.track(progress)).toBeDefined();
    now += 100;
    expect(client.track(progress)).toBeUndefined();
    expect(client.getEvents()).toHaveLength(1);

    await client.flush();
    expect(JSON.parse(body)).toEqual(expect.objectContaining({
      coalesced: 1,
      counters: [
        { eventName: "media.progress", outcome: "success", count: 2 },
      ],
    }));
    client.destroy();
  });

  it("evicts bounded queues, expires old evidence, and rotates idle episodes", () => {
    const drops: string[] = [];
    let now = 1_000;
    const client = createSemanticJourneyClient(clientConfig({
      now: () => now,
      maxQueueEvents: 2,
      maxEventAgeMs: 10,
      episodeIdleMs: 100,
      onDrop: (reason) => drops.push(reason),
    }));

    const first = client.track(submitInput());
    now += 1;
    client.track(submitInput());
    now += 1;
    client.track(submitInput());
    expect(client.getEvents()).toHaveLength(2);
    expect(drops).toEqual(["queue-limit"]);

    now += 20;
    expect(client.getEvents()).toEqual([]);
    expect(drops).toEqual(["queue-limit", "expired", "expired"]);

    const beforeIdle = client.track(submitInput());
    now += 100;
    const afterIdle = client.track(submitInput());
    expect(afterIdle?.journeyId).not.toBe(beforeIdle?.journeyId);
    expect(afterIdle?.journeyId).not.toBe(first?.journeyId);
    expect(client.getEvents()).toHaveLength(1);
    client.destroy();
  });

  it("deduplicates concurrent flushes and keeps one transport request in flight", async () => {
    let release: (() => void) | undefined;
    const transport = vi.fn(
      () => new Promise<void>((resolve) => {
        release = resolve;
      })
    );
    const client = createSemanticJourneyClient(clientConfig({
      aggregateEndpoint: "/api/analytics/semantic-aggregates",
      aggregateTransport: transport,
    }));
    client.track(submitInput());

    const first = client.flush();
    const second = client.flush();
    expect(first).toBe(second);
    expect(transport).toHaveBeenCalledTimes(1);
    release?.();
    await Promise.all([first, second]);

    await client.flush();
    expect(transport).toHaveBeenCalledTimes(1);
    client.destroy();
  });

  it("bounds transient retries and honours retry-after without changing the batch", async () => {
    const bodies: string[] = [];
    const delays: number[] = [];
    const transport = vi.fn(async ({ body }) => {
      bodies.push(body);
      if (bodies.length < 3) {
        throw new SemanticJourneyTransportError(
          "rejected",
          true,
          429,
          750
        );
      }
    });
    const client = createSemanticJourneyClient(clientConfig({
      aggregateEndpoint: "/api/analytics/semantic-aggregates",
      aggregateTransport: transport,
      maxRetries: 2,
      retryDelay: async (delayMs) => {
        delays.push(delayMs);
      },
    }));
    client.track(submitInput());

    await client.flush();

    expect(transport).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([750, 750]);
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0] ?? "{}").batchId).toBeDefined();
    client.destroy();
  });

  it("applies bounded jitter when a transient failure has no retry-after", async () => {
    const delays: number[] = [];
    let attempts = 0;
    const client = createSemanticJourneyClient(clientConfig({
      aggregateEndpoint: "/api/analytics/semantic-aggregates",
      aggregateTransport: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("synthetic transport failure");
        }
      },
      maxRetries: 1,
      retryBaseDelayMs: 100,
      retryMaxDelayMs: 100,
      retryDelay: async (delayMs) => {
        delays.push(delayMs);
      },
    }));
    client.track(submitInput());

    await client.flush();

    expect(attempts).toBe(2);
    expect(delays).toHaveLength(1);
    expect(delays[0]).toBeGreaterThanOrEqual(1);
    expect(delays[0]).toBeLessThanOrEqual(100);
    client.destroy();
  });

  it("discards permanently rejected aggregate batches with a bounded reason", async () => {
    const drops: string[] = [];
    const transport = vi.fn(async () => {
      throw new SemanticJourneyTransportError("rejected", false, 400);
    });
    const client = createSemanticJourneyClient(clientConfig({
      aggregateEndpoint: "/api/analytics/semantic-aggregates",
      aggregateTransport: transport,
      onDrop: (reason) => drops.push(reason),
    }));
    client.track(submitInput());

    await client.flush();
    await client.flush();

    expect(transport).toHaveBeenCalledTimes(1);
    expect(drops).toEqual(["transport-rejected"]);
    client.destroy();
  });

  it("times out a transport that ignores cancellation and retains its aggregate", async () => {
    vi.useFakeTimers();
    try {
      const bodies: string[] = [];
      const transport = vi.fn((request: SemanticJourneyAggregateTransportRequest) => {
        bodies.push(request.body);
        return new Promise<void>(() => undefined);
      });
      const client = createSemanticJourneyClient(clientConfig({
        aggregateEndpoint: "/api/analytics/semantic-aggregates",
        aggregateTransport: transport,
        requestTimeoutMs: 10,
        maxRetries: 0,
      }));
      client.track(submitInput());

      const flush = client.flush();
      await vi.advanceTimersByTimeAsync(10);
      await flush;
      expect(transport).toHaveBeenCalledTimes(1);

      const secondFlush = client.flush();
      await vi.advanceTimersByTimeAsync(10);
      await secondFlush;
      expect(transport).toHaveBeenCalledTimes(2);
      expect(bodies[1]).toBe(bodies[0]);
      expect(JSON.parse(bodies[1] ?? "{}").batchId).toBe(
        JSON.parse(bodies[0] ?? "{}").batchId
      );
      client.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("joins validated backend consequences to a private frontend story", () => {
    let now = 1_000;
    const client = createSemanticJourneyClient(clientConfig({ now: () => now++ }));
    const interaction = client.track(submitInput());
    const request = client.beginRequest(
      {
        name: "checkout.create",
        category: "request",
        phase: "start",
        outcome: "unknown",
      },
      { causedByEventId: interaction?.eventId }
    );
    expect(request).toBeDefined();
    expect(request?.traceparent).toMatch(
      /^00-[0-9a-f]{32}-[0-9a-f]{16}-00$/
    );
    expect(request?.traceparent).not.toContain(interaction?.journeyId ?? "missing");
    expect(() => {
      (request?.requestEvent as { eventId: string }).eventId = "f".repeat(32);
    }).toThrow();

    const receipt: SemanticJourneyConsequenceReceipt = {
      version: "1",
      name: "order.create",
      phase: "end",
      outcome: "denied",
      effect: "policy-denied",
    };
    const header = serializeSemanticJourneyReceipts([receipt], catalogue);
    const consequences = request?.complete(header) ?? [];

    expect(consequences).toHaveLength(1);
    expect(consequences[0]).toEqual(expect.objectContaining({
      channel: "backend",
      runtime: "server",
      name: "order.create",
      causedByEventId: request?.requestEvent.eventId,
      target: { type: "effect", id: "policy-denied" },
    }));
    expect(request?.complete(header)).toEqual([]);
    const replay = client.reconstruct();
    expect(replay.completeness).toBe("complete");
    expect(replay.steps.map((step) => step.name)).toEqual([
      "checkout.submit",
      "checkout.create",
      "order.create",
    ]);
    expect(JSON.stringify(replay)).not.toContain("validationState");
    client.destroy();
  });

  it("uses a fresh server-visible trace for every outbound request", () => {
    const client = createSemanticJourneyClient(clientConfig());
    const first = client.beginRequest({
      name: "checkout.create",
      category: "request",
      phase: "start",
      outcome: "unknown",
    });
    const second = client.beginRequest({
      name: "checkout.create",
      category: "request",
      phase: "start",
      outcome: "unknown",
    });

    expect(first?.traceparent.split("-")[1]).toBeDefined();
    expect(second?.traceparent.split("-")[1]).not.toBe(
      first?.traceparent.split("-")[1]
    );
    expect(first?.requestEvent.journeyId).toBe(second?.requestEvent.journeyId);
    client.destroy();
  });

  it("drops a late consequence instead of mixing it into a rotated episode", () => {
    let now = 1_000;
    const drops: string[] = [];
    const client = createSemanticJourneyClient(clientConfig({
      now: () => now,
      episodeIdleMs: 10,
      onDrop: (reason) => drops.push(reason),
    }));
    const request = client.beginRequest({
      name: "checkout.create",
      category: "request",
      phase: "start",
      outcome: "unknown",
    });
    const header = serializeSemanticJourneyReceipts([
      {
        version: "1",
        name: "order.create",
        phase: "end",
        outcome: "success",
        effect: "order-accepted",
      },
    ], catalogue);

    now += 10;
    expect(request?.complete(header)).toEqual([]);
    expect(client.getEvents()).toEqual([]);
    expect(drops).toContain("expired");
    client.destroy();
  });

  it("flushes aggregates on the interval and page lifecycle boundary", async () => {
    vi.useFakeTimers();
    try {
      const transport = vi.fn(
        async (_request: SemanticJourneyAggregateTransportRequest) => undefined
      );
      const client = createSemanticJourneyClient(clientConfig({
        autoFlush: true,
        aggregateFlushIntervalMs: 1_000,
        aggregateEndpoint: "/api/analytics/semantic-aggregates",
        aggregateTransport: transport,
      }));
      client.track(submitInput());

      await vi.advanceTimersByTimeAsync(1_000);
      expect(transport).toHaveBeenCalledTimes(1);

      client.track(submitInput());
      window.dispatchEvent(new Event("pagehide"));
      await Promise.resolve();
      await Promise.resolve();
      expect(transport).toHaveBeenCalledTimes(2);
      expect(transport.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
        keepalive: true,
      }));

      client.rotate();
      expect(client.getEvents()).toEqual([]);
      client.destroy();
      client.destroy();
      expect(client.track(submitInput())).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(transport).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a single event that cannot fit the local byte bound", () => {
    const drops: string[] = [];
    const client = createSemanticJourneyClient(clientConfig({
      maxQueueBytes: 512,
      onDrop: (reason) => drops.push(reason),
    }));

    expect(client.track(submitInput())).toBeUndefined();
    expect(client.getEvents()).toEqual([]);
    expect(drops).toEqual(["queue-limit"]);
    client.destroy();
  });

  it("clears both local evidence and pending aggregate counters", async () => {
    const transport = vi.fn(async () => undefined);
    const client = createSemanticJourneyClient(clientConfig({
      aggregateEndpoint: "/api/analytics/semantic-aggregates",
      aggregateTransport: transport,
    }));
    client.track(submitInput());
    client.clear();

    expect(client.getEvents()).toEqual([]);
    await client.flush();
    expect(transport).not.toHaveBeenCalled();
    client.destroy();
  });

  it("cancels an old generation so its acknowledgement cannot erase new counts", async () => {
    let resolveFirst: (() => void) | undefined;
    const bodies: string[] = [];
    const transport = vi.fn((request: SemanticJourneyAggregateTransportRequest) => {
      bodies.push(request.body);
      if (bodies.length === 1) {
        return new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve();
    });
    const client = createSemanticJourneyClient(clientConfig({
      aggregateEndpoint: "/api/analytics/semantic-aggregates",
      aggregateTransport: transport,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
    }));
    client.track(submitInput());
    const oldFlush = client.flush();

    client.clear();
    client.track(submitInput());
    await oldFlush;
    await client.flush();
    resolveFirst?.();

    expect(transport).toHaveBeenCalledTimes(2);
    expect(JSON.parse(bodies[1] ?? "{}").counters).toEqual([
      { eventName: "checkout.submit", outcome: "unknown", count: 1 },
    ]);
    client.destroy();
  });

  it("rejects insecure remote aggregate endpoints without echoing them", () => {
    const endpointCanary = "http://analytics.example.invalid/private-canary";
    let thrown: unknown;
    try {
      createSemanticJourneyClient(clientConfig({ aggregateEndpoint: endpointCanary }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(String(thrown)).toBe("Error: Semantic journey client configuration is invalid.");
    expect(String(thrown)).not.toContain(endpointCanary);
  });

  it("rejects protocol-relative endpoints and unbounded load controls", () => {
    expect(() => createSemanticJourneyClient(clientConfig({
      aggregateEndpoint: "//collector.example.invalid/events",
    }))).toThrow("Semantic journey client configuration is invalid.");
    expect(() => createSemanticJourneyClient(clientConfig({
      aggregateFlushIntervalMs: 999,
    }))).toThrow("Semantic journey client configuration is invalid.");
    expect(() => createSemanticJourneyClient(clientConfig({
      aggregateMaxBytes: 61 * 1024,
    }))).toThrow("Semantic journey client configuration is invalid.");
    expect(() => createSemanticJourneyClient(clientConfig({
      maxRetries: 6,
    }))).toThrow("Semantic journey client configuration is invalid.");
  });

  it("requires the aggregate source to be explicitly catalogue-approved", () => {
    const sourceCatalogue = defineSemanticJourneyCatalog({
      "safe.event": { category: "state" },
    }, { sources: ["approved.site"] });

    expect(() => createSemanticJourneyClient({
      catalogue: sourceCatalogue,
      source: "alice-synthetic",
      enabled: true,
      autoFlush: false,
    })).toThrow("Semantic journey client configuration is invalid.");
  });

  it("uses a package-owned policy version instead of caller-shaped data", async () => {
    let body = "";
    const configWithUnknownPolicy = {
      ...clientConfig({
        aggregateEndpoint: "/api/analytics/semantic-aggregates",
        aggregateTransport: async (request: SemanticJourneyAggregateTransportRequest) => {
          body = request.body;
        },
      }),
      policyVersion: "user-123",
    } as unknown as SemanticJourneyClientConfig;
    const client = createSemanticJourneyClient(configWithUnknownPolicy);
    client.track(submitInput());

    await client.flush();

    expect(JSON.parse(body).policyVersion).toBe("strict.v1");
    expect(body).not.toContain("user-123");
    client.destroy();
  });
});

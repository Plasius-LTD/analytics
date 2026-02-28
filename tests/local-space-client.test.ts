import { afterEach, describe, expect, it } from "vitest";
import { createLocalSpaceAnalyticsClient } from "../src/core/client.js";
import type { AnalyticsTransportRequest, LocalSpaceAnalyticsClient } from "../src/core/types.js";

const createdClients: LocalSpaceAnalyticsClient[] = [];

function createClient(config: Parameters<typeof createLocalSpaceAnalyticsClient>[0]) {
  const client = createLocalSpaceAnalyticsClient(config);
  createdClients.push(client);
  return client;
}

afterEach(() => {
  for (const client of createdClients) {
    client.destroy();
  }
  createdClients.length = 0;
  window.localStorage.clear();
});

describe("createLocalSpaceAnalyticsClient", () => {
  it("buffers interaction events and sends them to the configured endpoint", async () => {
    const requests: AnalyticsTransportRequest[] = [];

    const client = createClient({
      source: "sharedcomponents",
      endpoint: "https://example.com/analytics",
      batchSize: 10,
      flushIntervalMs: 60000,
      storageKey: "analytics-client-test-buffer-send",
      transport: async (request) => {
        requests.push(request);
      },
    });

    client.track({ component: "Header", action: "nav_click", label: "About" });
    client.track({ component: "Footer", action: "nav_click", label: "Privacy" });

    await client.flush();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.endpoint).toBe("https://example.com/analytics");

    const payload = JSON.parse(requests[0]?.body ?? "{}") as {
      source?: string;
      events?: Array<{ component?: string; action?: string; label?: string }>;
    };

    expect(payload.source).toBe("sharedcomponents");
    expect(payload.events).toHaveLength(2);
    expect(payload.events?.[0]?.component).toBe("Header");
    expect(payload.events?.[0]?.action).toBe("nav_click");
    expect(payload.events?.[1]?.component).toBe("Footer");
  });

  it("keeps events in local storage until an endpoint is provided", async () => {
    const requests: AnalyticsTransportRequest[] = [];

    const client = createClient({
      source: "sharedcomponents",
      batchSize: 10,
      flushIntervalMs: 60000,
      storageKey: "analytics-client-test-late-endpoint",
      transport: async (request) => {
        requests.push(request);
      },
    });

    client.track({ component: "UserProfile", action: "open_menu", label: "Avatar" });

    const pendingRaw = window.localStorage.getItem("analytics-client-test-late-endpoint");
    const pending = pendingRaw ? (JSON.parse(pendingRaw) as unknown[]) : [];

    expect(pending.length).toBe(1);

    client.updateConfig({ endpoint: "https://example.com/analytics" });
    await client.flush();

    expect(requests).toHaveLength(1);
    expect(window.localStorage.getItem("analytics-client-test-late-endpoint")).toBeNull();
  });

  it("drops oldest events when maxQueueSize is exceeded", () => {
    const client = createClient({
      source: "sharedcomponents",
      maxQueueSize: 2,
      batchSize: 50,
      flushIntervalMs: 60000,
      storageKey: "analytics-client-test-queue-cap",
    });

    client.track({ component: "Header", action: "a" });
    client.track({ component: "Header", action: "b" });
    client.track({ component: "Header", action: "c" });

    const raw = window.localStorage.getItem("analytics-client-test-queue-cap");
    const queue = raw
      ? (JSON.parse(raw) as Array<{ action?: string }>)
      : [];

    expect(queue).toHaveLength(2);
    expect(queue[0]?.action).toBe("b");
    expect(queue[1]?.action).toBe("c");
  });
});

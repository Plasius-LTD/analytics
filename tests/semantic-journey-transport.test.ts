import { describe, expect, it, vi } from "vitest";

import {
  createDefaultSemanticJourneyAggregateTransport,
  isSecureSemanticJourneyEndpoint,
  SemanticJourneyTransportError,
} from "../src/journey/transport.js";

function request(endpoint: string, signal = new AbortController().signal) {
  return {
    endpoint,
    body: "{}",
    headers: { "content-type": "application/json" },
    signal,
  };
}

describe("semantic journey aggregate transport", () => {
  it("allows TLS, same-origin relative, and localhost endpoints only", () => {
    expect(isSecureSemanticJourneyEndpoint("https://example.test/events")).toBe(true);
    expect(isSecureSemanticJourneyEndpoint("/api/events", "https://example.test")).toBe(true);
    expect(isSecureSemanticJourneyEndpoint("//evil.example/events", "https://example.test")).toBe(false);
    expect(isSecureSemanticJourneyEndpoint("/\\evil.example/events", "https://example.test")).toBe(false);
    expect(isSecureSemanticJourneyEndpoint("http://localhost:7071/events")).toBe(true);
    expect(isSecureSemanticJourneyEndpoint("http://example.test/events")).toBe(false);
    expect(isSecureSemanticJourneyEndpoint("javascript:alert(1)")).toBe(false);
  });

  it("posts without reading or returning response bodies", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("sensitive response", {
      status: 202,
    }));
    const transport = createDefaultSemanticJourneyAggregateTransport({
      fetch: fetchMock,
    });

    await transport(request("https://example.test/events"));

    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.test/events",
      expect.objectContaining({
        method: "POST",
        body: "{}",
        keepalive: false,
        credentials: "omit",
        referrerPolicy: "no-referrer",
        redirect: "error",
      }),
    );
  });

  it("resolves server-relative endpoints without credentials or referrers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, {
      status: 202,
    }));
    const transport = createDefaultSemanticJourneyAggregateTransport({
      fetch: fetchMock,
      baseUrl: "https://site.example.test/base",
    });

    await transport(request("/api/events"));

    expect(fetchMock).toHaveBeenCalledWith(
      "https://site.example.test/api/events",
      expect.objectContaining({
        credentials: "omit",
        referrerPolicy: "no-referrer",
        redirect: "error",
      }),
    );
  });

  it("uses bounded Fetch keepalive only when requested by a lifecycle flush", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, {
      status: 202,
    }));
    const transport = createDefaultSemanticJourneyAggregateTransport({
      fetch: fetchMock,
    });

    await transport({
      ...request("https://example.test/events"),
      keepalive: true,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.test/events",
      expect.objectContaining({ keepalive: true }),
    );
  });

  it("classifies retryable status and bounds Retry-After", async () => {
    const transport = createDefaultSemanticJourneyAggregateTransport({
      fetch: vi.fn().mockResolvedValue(new Response(null, {
        status: 429,
        headers: { "retry-after": "999999" },
      })),
    });

    const error = await transport(request("https://example.test/events"))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SemanticJourneyTransportError);
    expect(error).toMatchObject({
      code: "rejected",
      retryable: true,
      status: 429,
      retryAfterMs: 300_000,
    });
    expect(String(error)).not.toContain("example.test");
  });

  it("fails closed for insecure endpoints before calling fetch", async () => {
    const fetchMock = vi.fn();
    const transport = createDefaultSemanticJourneyAggregateTransport({
      fetch: fetchMock,
    });

    const error = await transport(request("http://events.example.test/collect"))
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "rejected", retryable: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports aborts without copying the underlying error", async () => {
    const controller = new AbortController();
    const transport = createDefaultSemanticJourneyAggregateTransport({
      fetch: vi.fn().mockImplementation(async () => {
        controller.abort();
        throw new Error("token=synthetic-secret");
      }),
    });

    const error = await transport(request("https://example.test/events", controller.signal))
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "aborted", retryable: true });
    expect(String(error)).not.toContain("synthetic-secret");
  });

  it("reports a retryable network failure without reflecting its cause", async () => {
    const transport = createDefaultSemanticJourneyAggregateTransport({
      fetch: vi.fn().mockRejectedValue(
        new Error("synthetic-network-private-canary")
      ),
    });

    const error = await transport(request("https://example.test/events"))
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "network_failure", retryable: true });
    expect(String(error)).not.toContain("synthetic-network-private-canary");
  });
});

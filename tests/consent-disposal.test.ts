// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFrontendAnalyticsClient } from "../src/core/client.js";
afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });
describe("withdrawal discards optional analytics", () => {
  it("aborts transport and never restores a queue after a late success", async () => {
    let complete!: () => void;
    let signal: AbortSignal | undefined;
    const transport = vi.fn(request => {
      signal = request.signal;
      return new Promise<void>(resolve => { complete = resolve; });
    });
    const client = createFrontendAnalyticsClient({ source: "consent-test", endpoint: "/api/events", storageKey: "consent-test", transport });
    client.track({ component: "test", action: "select" });
    const pending = client.flush();
    expect(localStorage.getItem("consent-test")).not.toBeNull();
    client.destroy({ discard: true });
    expect(signal?.aborted).toBe(true);
    expect(localStorage.getItem("consent-test")).toBeNull();
    complete();
    await pending;
    window.dispatchEvent(new Event("pagehide"));
    await client.flush();
    client.track({ component: "test", action: "after-withdrawal" });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("consent-test")).toBeNull();
    expect(client.getIssueReports()).toEqual([]);
  });
  it("passes cancellation to fetch and suppresses late errors after disposal", async () => {
    let reject!: (error: Error) => void;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise((_r, fail) => { reject = fail; }));
    const onError = vi.fn();
    const client = createFrontendAnalyticsClient({ source: "consent-test", endpoint: "https://example.invalid/events", onError });
    client.track({ component: "test", action: "select" });
    const pending = client.flush();
    const signal = fetchMock.mock.calls[0]![1]!.signal;
    client.destroy({ discard: true });
    expect(signal?.aborted).toBe(true);
    reject(new Error("aborted"));
    await pending;
    expect(onError).not.toHaveBeenCalled();
  });
});

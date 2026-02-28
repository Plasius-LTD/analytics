import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  AnalyticsProvider,
  useAnalytics,
  useComponentInteractionTracker,
} from "../src/index.js";
import type { AnalyticsTransportRequest } from "../src/core/types.js";

function TrackedButton() {
  const track = useComponentInteractionTracker("TrackedButton", {
    surface: "unit-test",
  });

  return (
    <button
      type="button"
      onClick={() =>
        track("click", {
          label: "Track me",
          context: { intent: "cta" },
        })
      }
    >
      Track me
    </button>
  );
}

function FlushButton() {
  const { flush } = useAnalytics();

  return (
    <button
      type="button"
      onClick={() => {
        void flush();
      }}
    >
      Flush
    </button>
  );
}

describe("AnalyticsProvider", () => {
  it("provides tracking helpers to child components", async () => {
    const requests: AnalyticsTransportRequest[] = [];

    render(
      <AnalyticsProvider
        source="sharedcomponents"
        endpoint="https://example.com/analytics"
        batchSize={50}
        flushIntervalMs={60000}
        transport={async (request) => {
          requests.push(request);
        }}
      >
        <TrackedButton />
        <FlushButton />
      </AnalyticsProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Track me" }));
    fireEvent.click(screen.getByRole("button", { name: "Flush" }));

    expect(requests).toHaveLength(1);

    const payload = JSON.parse(requests[0]?.body ?? "{}") as {
      events?: Array<{
        component?: string;
        action?: string;
        label?: string;
        context?: Record<string, unknown>;
      }>;
    };

    expect(payload.events?.[0]?.component).toBe("TrackedButton");
    expect(payload.events?.[0]?.action).toBe("click");
    expect(payload.events?.[0]?.label).toBe("Track me");
    expect(payload.events?.[0]?.context).toMatchObject({
      surface: "unit-test",
      intent: "cta",
    });
  });

  it("throws if useAnalytics is called outside AnalyticsProvider", () => {
    const renderOutsideProvider = () => {
      function Broken() {
        useAnalytics();
        return null;
      }

      render(<Broken />);
    };

    expect(renderOutsideProvider).toThrow(/must be used within AnalyticsProvider/i);
  });

  it("can be disabled", () => {
    const transportSpy = vi.fn();

    render(
      <AnalyticsProvider
        source="sharedcomponents"
        enabled={false}
        endpoint="https://example.com/analytics"
        transport={transportSpy}
      >
        <TrackedButton />
      </AnalyticsProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Track me" }));

    expect(transportSpy).not.toHaveBeenCalled();
  });
});

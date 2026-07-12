import { afterEach, describe, expect, it, vi } from "vitest";

import { observeSemanticJourneyInteractions } from "../src/journey/browser.js";
import { defineSemanticJourneyCatalog } from "../src/journey/catalog.js";
import type { SemanticJourneyEventInput } from "../src/journey/types.js";

const catalogue = defineSemanticJourneyCatalog({
  "checkout.submit": {
    category: "interaction",
    attributes: {},
    targets: [{ type: "control", id: "checkout.primary" }],
  },
  "form.submit": { category: "interaction", attributes: {} },
  "field.changed": { category: "state", attributes: {} },
  "menu.toggled": { category: "presentation", attributes: {} },
  "media.lifecycle": { category: "presentation", attributes: {} },
  "drop.completed": { category: "interaction", attributes: {} },
}, { sources: ["site"] });

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function annotate(element: Element, eventName: string): void {
  element.setAttribute("data-plasius-event", eventName);
}

describe("observeSemanticJourneyInteractions", () => {
  it("emits only registered developer-authored semantics and approved target tokens", () => {
    const inputs: SemanticJourneyEventInput[] = [];
    const root = document.createElement("section");
    const button = document.createElement("button");
    const nested = document.createElement("span");

    annotate(button, "checkout.submit");
    button.setAttribute("data-plasius-target-type", "control");
    button.setAttribute("data-plasius-target-id", "checkout.primary");
    button.setAttribute("aria-label", "PRIVATE_CANARY");
    button.setAttribute("data-private-context", "PRIVATE_CANARY");
    button.value = "PRIVATE_CANARY";
    nested.textContent = "PRIVATE_CANARY";
    button.append(nested);
    root.append(button);
    document.body.append(root);

    const getAttribute = vi.spyOn(button, "getAttribute");
    const stop = observeSemanticJourneyInteractions({
      catalogue,
      root,
      enabled: true,
      onEvent: (input) => inputs.push(input),
    });

    nested.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));

    expect(inputs).toEqual([
      {
        name: "checkout.submit",
        category: "interaction",
        phase: "intent",
        outcome: "unknown",
        modality: "pointer",
        target: { type: "control", id: "checkout.primary" },
      },
    ]);
    expect(JSON.stringify(inputs)).not.toContain("PRIVATE_CANARY");
    expect(getAttribute.mock.calls.map(([name]) => name)).toEqual([
      "data-plasius-event",
      "data-plasius-target-type",
      "data-plasius-target-id",
    ]);

    stop();
    nested.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(inputs).toHaveLength(1);
  });

  it("covers semantic click, submit, change, toggle, media, and drop classes with delegation", () => {
    const inputs: SemanticJourneyEventInput[] = [];
    const root = document.createElement("section");
    document.body.append(root);

    const cases: Array<{
      element: Element;
      eventName: string;
      eventType: string;
      phase: SemanticJourneyEventInput["phase"];
      outcome: SemanticJourneyEventInput["outcome"];
    }> = [
      {
        element: document.createElement("button"),
        eventName: "checkout.submit",
        eventType: "click",
        phase: "intent",
        outcome: "unknown",
      },
      {
        element: document.createElement("form"),
        eventName: "form.submit",
        eventType: "submit",
        phase: "intent",
        outcome: "unknown",
      },
      {
        element: document.createElement("input"),
        eventName: "field.changed",
        eventType: "change",
        phase: "effect",
        outcome: "success",
      },
      {
        element: document.createElement("details"),
        eventName: "menu.toggled",
        eventType: "toggle",
        phase: "effect",
        outcome: "success",
      },
      {
        element: document.createElement("video"),
        eventName: "media.lifecycle",
        eventType: "play",
        phase: "start",
        outcome: "unknown",
      },
      {
        element: document.createElement("video"),
        eventName: "media.lifecycle",
        eventType: "pause",
        phase: "progress",
        outcome: "success",
      },
      {
        element: document.createElement("video"),
        eventName: "media.lifecycle",
        eventType: "ended",
        phase: "end",
        outcome: "success",
      },
      {
        element: document.createElement("div"),
        eventName: "drop.completed",
        eventType: "drop",
        phase: "effect",
        outcome: "success",
      },
    ];

    const stop = observeSemanticJourneyInteractions({
      catalogue,
      root,
      enabled: true,
      onEvent: (input) => inputs.push(input),
    });

    for (const item of cases) {
      annotate(item.element, item.eventName);
      root.append(item.element);
      const event = item.eventType === "click"
        ? new MouseEvent("click", { bubbles: false, detail: 0 })
        : new Event(item.eventType, { bubbles: false });
      item.element.dispatchEvent(event);
    }

    expect(inputs.map(({ name, phase, outcome }) => ({ name, phase, outcome }))).toEqual(
      cases.map(({ eventName: name, phase, outcome }) => ({ name, phase, outcome }))
    );
    expect(inputs[0]?.modality).toBe("keyboard");

    const annotatedInput = cases[2]?.element;
    annotatedInput?.dispatchEvent(new InputEvent("input", { bubbles: true, data: "PRIVATE_CANARY" }));
    annotatedInput?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "PRIVATE_CANARY" }));
    annotatedInput?.dispatchEvent(new Event("scroll", { bubbles: true }));
    expect(inputs).toHaveLength(cases.length);

    stop();
  });

  it("fails closed for absent, unknown, or invalid event tokens without retaining invalid target data", () => {
    const inputs: SemanticJourneyEventInput[] = [];
    const root = document.createElement("section");
    document.body.append(root);
    const stop = observeSemanticJourneyInteractions({
      catalogue,
      root,
      enabled: true,
      onEvent: (input) => inputs.push(input),
    });

    const absent = document.createElement("button");
    const unknown = document.createElement("button");
    const invalid = document.createElement("button");
    const invalidTarget = document.createElement("button");
    const unregisteredTarget = document.createElement("button");
    annotate(unknown, "unknown.event");
    annotate(invalid, "invalid@PRIVATE_CANARY");
    annotate(invalidTarget, "checkout.submit");
    invalidTarget.setAttribute("data-plasius-target-type", "control");
    invalidTarget.setAttribute("data-plasius-target-id", "invalid@PRIVATE_CANARY");
    annotate(unregisteredTarget, "checkout.submit");
    unregisteredTarget.setAttribute("data-plasius-target-type", "control");
    unregisteredTarget.setAttribute("data-plasius-target-id", "alice-synthetic");
    root.append(absent, unknown, invalid, invalidTarget, unregisteredTarget);

    for (const element of [
      absent,
      unknown,
      invalid,
      invalidTarget,
      unregisteredTarget,
    ]) {
      element.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    }

    expect(inputs).toEqual([]);
    expect(JSON.stringify(inputs)).not.toContain("PRIVATE_CANARY");
    stop();
  });

  it("installs no listeners when the resolved rollout state is disabled", () => {
    const onEvent = vi.fn();
    const root = document.createElement("section");
    const button = document.createElement("button");
    annotate(button, "checkout.submit");
    root.append(button);

    const stop = observeSemanticJourneyInteractions({
      catalogue,
      root,
      enabled: false,
      onEvent,
    });
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onEvent).not.toHaveBeenCalled();
    expect(stop).not.toThrow();
  });

  it("also defaults to no listeners when rollout state is omitted at runtime", () => {
    const onEvent = vi.fn();
    const root = document.createElement("section");
    const button = document.createElement("button");
    annotate(button, "checkout.submit");
    root.append(button);

    const stop = observeSemanticJourneyInteractions({
      catalogue,
      root,
      onEvent,
    } as unknown as Parameters<typeof observeSemanticJourneyInteractions>[0]);
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onEvent).not.toHaveBeenCalled();
    stop();
  });
});

import { describe, expect, it } from "vitest";
import { defineSemanticJourneyCatalog } from "../src/journey/catalog.js";
import { reconstructSemanticJourney } from "../src/journey/replay.js";
import type { SemanticJourneyEvent } from "../src/journey/types.js";

const catalogue = defineSemanticJourneyCatalog(
  {
    "checkout.submitOrder": {
      category: "interaction",
      attributes: {
        validationState: {
          type: "enum",
          values: ["valid", "invalid", "unknown"],
        },
      },
      targets: [{ type: "control", id: "submitButton" }],
    },
    "checkout.createOrder": { category: "request" },
    "order.create": { category: "command" },
    "checkout.showProblem": { category: "presentation" },
    "journey.step": { category: "interaction" },
  },
  { sources: ["siteWeb"] }
);

function hex32(value: number): string {
  return value.toString(16).padStart(32, "0");
}

function hex16(value: number): string {
  return value.toString(16).padStart(16, "0");
}

function journeyEvent(
  overrides: Partial<SemanticJourneyEvent> = {}
): SemanticJourneyEvent {
  return {
    schemaVersion: "2.0",
    eventId: hex32(1),
    journeyId: hex32(101),
    traceId: hex32(201),
    spanId: hex16(301),
    producerId: hex16(401),
    producerSequence: 1,
    occurredAtEpochMs: 1_000,
    source: "siteWeb",
    channel: "frontend",
    runtime: "browser",
    name: "journey.step",
    category: "interaction",
    phase: "intent",
    outcome: "unknown",
    attributes: {},
    privacy: {
      mode: "strict",
      policyVersion: "strict.v1",
      droppedAttributeCount: 0,
    },
    ...overrides,
  };
}

function completeJourney(): SemanticJourneyEvent[] {
  const interaction = journeyEvent({
    eventId: hex32(1),
    spanId: hex16(1),
    producerSequence: 1,
    occurredAtEpochMs: 400,
    name: "checkout.submitOrder",
    modality: "keyboard",
    target: { type: "control", id: "submitButton" },
    attributes: { validationState: "valid" },
  });
  const request = journeyEvent({
    eventId: hex32(2),
    spanId: hex16(2),
    parentSpanId: interaction.spanId,
    causedByEventId: interaction.eventId,
    producerSequence: 2,
    occurredAtEpochMs: 300,
    name: "checkout.createOrder",
    category: "request",
    phase: "start",
  });
  const command = journeyEvent({
    eventId: hex32(3),
    spanId: hex16(3),
    parentSpanId: request.spanId,
    causedByEventId: request.eventId,
    producerId: hex16(402),
    producerSequence: 1,
    occurredAtEpochMs: 200,
    channel: "backend",
    runtime: "server",
    name: "order.create",
    category: "command",
    phase: "end",
    outcome: "denied",
  });
  const presentation = journeyEvent({
    eventId: hex32(4),
    spanId: hex16(4),
    parentSpanId: command.spanId,
    causedByEventId: command.eventId,
    producerSequence: 3,
    occurredAtEpochMs: 100,
    name: "checkout.showProblem",
    category: "presentation",
    phase: "effect",
    outcome: "success",
  });

  return [interaction, request, command, presentation];
}

function replay(events: readonly SemanticJourneyEvent[]) {
  return reconstructSemanticJourney(catalogue, events);
}

describe("reconstructSemanticJourney", () => {
  it("orders frontend and backend consequences by causal evidence before timestamps", () => {
    const result = replay([...completeJourney()].reverse());

    expect(result.completeness).toBe("complete");
    expect(result.journeyId).toBe(hex32(101));
    expect(result.evidence).toEqual([]);
    expect(result.steps.map((step) => step.eventId)).toEqual([
      hex32(1),
      hex32(2),
      hex32(3),
      hex32(4),
    ]);
    expect(result.steps[0]?.explanation).toBe(
      "frontend interaction checkout.submitOrder intent by keyboard target control submitButton outcome unknown"
    );
    expect(result.steps[2]?.explanation).toBe(
      "backend command order.create end outcome denied"
    );
    expect(result.steps[2]?.predecessorEventIds).toEqual([hex32(2)]);
  });

  it("is invariant to delivery order and identical duplicate event IDs", () => {
    const events = completeJourney();
    const forward = replay(events);
    const reorderedWithDuplicates = replay([
      events[3]!,
      events[1]!,
      events[0]!,
      events[1]!,
      events[2]!,
      events[0]!,
    ]);

    expect(reorderedWithDuplicates).toEqual(forward);
    expect(reorderedWithDuplicates.steps).toHaveLength(4);
  });

  it("rejects conflicting evidence that reuses an event ID", () => {
    const first = journeyEvent({ eventId: hex32(9), outcome: "success" });
    const conflict = journeyEvent({ eventId: hex32(9), outcome: "failure" });

    expect(replay([first, conflict])).toEqual({
      completeness: "invalid",
      steps: [],
      evidence: [expect.objectContaining({ code: "invalid-event" })],
    });
  });

  it("uses event IDs to break equal-timestamp topological ties", () => {
    const eventB = journeyEvent({
      eventId: hex32(12),
      spanId: hex16(12),
      producerId: hex16(412),
    });
    const eventA = journeyEvent({
      eventId: hex32(11),
      spanId: hex16(11),
      producerId: hex16(411),
    });

    expect(replay([eventB, eventA]).steps.map((step) => step.eventId)).toEqual([
      hex32(11),
      hex32(12),
    ]);
  });

  it("marks missing links and producer sequence gaps as partial evidence", () => {
    const first = journeyEvent({
      eventId: hex32(21),
      spanId: hex16(21),
      producerSequence: 1,
    });
    const third = journeyEvent({
      eventId: hex32(23),
      spanId: hex16(23),
      parentSpanId: hex16(99),
      causedByEventId: hex32(99),
      producerSequence: 3,
    });

    const result = replay([third, first]);

    expect(result.completeness).toBe("partial");
    expect(result.steps.map((step) => step.eventId)).toEqual([
      hex32(21),
      hex32(23),
    ]);
    expect(result.evidence.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "missing-parent",
        "missing-cause",
        "sequence-gap",
      ])
    );
    expect(result.evidence).toContainEqual(
      expect.objectContaining({
        code: "sequence-gap",
        producerId: hex16(401),
        expectedSequence: 2,
        observedSequence: 3,
      })
    );
  });

  it("marks a missing producer sequence prefix as partial evidence", () => {
    const result = replay([
      journeyEvent({
        eventId: hex32(33),
        spanId: hex16(33),
        producerSequence: 3,
      }),
    ]);

    expect(result.completeness).toBe("partial");
    expect(result.evidence).toContainEqual(
      expect.objectContaining({
        code: "sequence-gap",
        expectedSequence: 1,
        observedSequence: 3,
      })
    );
  });

  it("detects producer forks without inventing an order within a fork", () => {
    const forkB = journeyEvent({
      eventId: hex32(42),
      spanId: hex16(42),
      producerSequence: 1,
      occurredAtEpochMs: 100,
    });
    const later = journeyEvent({
      eventId: hex32(43),
      spanId: hex16(43),
      producerSequence: 2,
      occurredAtEpochMs: 1,
    });
    const forkA = journeyEvent({
      eventId: hex32(41),
      spanId: hex16(41),
      producerSequence: 1,
      occurredAtEpochMs: 100,
    });

    const result = replay([later, forkB, forkA]);

    expect(result.completeness).toBe("partial");
    expect(result.steps.map((step) => step.eventId)).toEqual([
      hex32(41),
      hex32(42),
      hex32(43),
    ]);
    expect(result.evidence).toContainEqual(
      expect.objectContaining({
        code: "sequence-fork",
        producerId: hex16(401),
        producerSequence: 1,
        eventIds: [hex32(41), hex32(42)],
      })
    );
  });

  it("identifies actual cycles without mislabelling downstream nodes", () => {
    const eventA = journeyEvent({
      eventId: hex32(51),
      spanId: hex16(51),
      producerId: hex16(451),
      causedByEventId: hex32(52),
    });
    const eventB = journeyEvent({
      eventId: hex32(52),
      spanId: hex16(52),
      producerId: hex16(452),
      causedByEventId: hex32(51),
    });
    const downstream = journeyEvent({
      eventId: hex32(53),
      spanId: hex16(53),
      producerId: hex16(453),
      causedByEventId: hex32(52),
    });

    const forward = replay([eventA, downstream, eventB]);
    const reverse = replay([eventB, downstream, eventA]);

    expect(forward).toEqual(reverse);
    expect(forward.completeness).toBe("invalid");
    expect(forward.steps.map((step) => step.eventId)).toEqual([
      hex32(51),
      hex32(52),
      hex32(53),
    ]);
    expect(forward.evidence).toContainEqual(
      expect.objectContaining({
        code: "cycle",
        eventIds: [hex32(51), hex32(52)],
      })
    );
    expect(
      forward.evidence
        .filter((item) => item.code === "cycle")
        .flatMap((item) => item.eventIds ?? [])
    ).not.toContain(hex32(53));
  });

  it("fails closed when events from multiple journeys are supplied", () => {
    const result = replay([
      journeyEvent({ eventId: hex32(61), journeyId: hex32(161) }),
      journeyEvent({ eventId: hex32(62), journeyId: hex32(162) }),
    ]);

    expect(result.completeness).toBe("invalid");
    expect(result.journeyId).toBeUndefined();
    expect(result.steps).toEqual([]);
    expect(result.evidence).toEqual([
      expect.objectContaining({
        code: "mixed-journey",
        observedCount: 2,
      }),
    ]);
  });

  it("reports an empty input as invalid without inventing a journey", () => {
    expect(replay([])).toEqual({
      completeness: "invalid",
      steps: [],
      evidence: [
        expect.objectContaining({
          code: "empty-journey",
          observedCount: 0,
        }),
      ],
    });
  });

  it("never copies registered attributes or their values into replay steps", () => {
    const result = replay(completeJourney());
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain("attributes");
    expect(serialized).not.toContain("validationState");
    expect(serialized).not.toContain("valid");
    expect(Object.keys(result.steps[0] ?? {})).not.toContain("attributes");
  });

  it("fails closed without projecting an invalid canary event", () => {
    const privateCanary = "canary.person@example.invalid";
    const invalid = {
      ...journeyEvent({ eventId: hex32(71), name: "checkout.submitOrder" }),
      attributes: { validationState: privateCanary },
    } as SemanticJourneyEvent;

    const result = replay([...completeJourney(), invalid]);
    const serialized = JSON.stringify(result);

    expect(result).toEqual({
      completeness: "invalid",
      steps: [],
      evidence: [expect.objectContaining({ code: "invalid-event" })],
    });
    expect(serialized).not.toContain(privateCanary);
    expect(serialized).not.toContain(hex32(71));
  });

  it.each([
    ["schema", { schemaVersion: "2.1" }],
    ["event ID", { eventId: "deadbeef" }],
    ["journey ID", { journeyId: "deadbeef" }],
    ["trace ID", { traceId: "deadbeef" }],
    ["span ID", { spanId: "deadbeef" }],
    ["parent span ID", { parentSpanId: "deadbeef" }],
    ["cause event ID", { causedByEventId: "deadbeef" }],
    ["producer ID", { producerId: "deadbeef" }],
    ["source", { source: "otherSite" }],
    ["event name", { name: "journey.unregistered" }],
    ["category", { category: "command" }],
    ["sequence", { producerSequence: 0 }],
    ["unsafe sequence", { producerSequence: Number.MAX_SAFE_INTEGER + 1 }],
    ["timestamp", { occurredAtEpochMs: 1.5 }],
    ["unsafe timestamp", { occurredAtEpochMs: Number.MAX_SAFE_INTEGER + 1 }],
    ["channel/runtime", { channel: "backend", runtime: "browser" }],
    [
      "target",
      {
        name: "checkout.submitOrder",
        target: { type: "control", id: "unregisteredButton" },
      },
    ],
    ["attribute", { attributes: { unregisteredAttribute: true } }],
    [
      "privacy mode",
      {
        privacy: {
          mode: "loose",
          policyVersion: "strict.v1",
          droppedAttributeCount: 0,
        },
      },
    ],
    [
      "privacy drop count",
      {
        privacy: {
          mode: "strict",
          policyVersion: "strict.v1",
          droppedAttributeCount: 1,
        },
      },
    ],
    ["event field", { unexpectedField: "private-canary" }],
    [
      "privacy field",
      {
        privacy: {
          mode: "strict",
          policyVersion: "strict.v1",
          droppedAttributeCount: 0,
          unexpectedField: "private-canary",
        },
      },
    ],
  ])("rejects runtime-invalid %s evidence", (_caseName, override) => {
    const invalid = { ...journeyEvent(), ...override } as SemanticJourneyEvent;

    expect(replay([invalid])).toEqual({
      completeness: "invalid",
      steps: [],
      evidence: [expect.objectContaining({ code: "invalid-event" })],
    });
  });

  it("rejects hostile accessors without evaluating or reflecting them", () => {
    const privateCanary = "hostile-canary@example.invalid";
    let evaluated = false;
    const invalid = { ...journeyEvent() } as Record<string, unknown>;
    Object.defineProperty(invalid, "name", {
      enumerable: true,
      get() {
        evaluated = true;
        throw new Error(privateCanary);
      },
    });

    const result = reconstructSemanticJourney(catalogue, [
      invalid as unknown as SemanticJourneyEvent,
    ]);

    expect(evaluated).toBe(false);
    expect(result.steps).toEqual([]);
    expect(result.evidence).toEqual([
      expect.objectContaining({ code: "invalid-event" }),
    ]);
    expect(JSON.stringify(result)).not.toContain(privateCanary);
  });

  it("fails closed when the event-count bound is exceeded", () => {
    const events = Array.from({ length: 5_001 }, () => journeyEvent());

    expect(replay(events)).toEqual({
      completeness: "invalid",
      steps: [],
      evidence: [expect.objectContaining({ code: "evidence-limit" })],
    });
  });

  it("fails closed when a trace/span group exceeds its fanout bound", () => {
    const events = Array.from({ length: 33 }, (_, index) =>
      journeyEvent({
        eventId: hex32(1_000 + index),
        producerId: hex16(1_000 + index),
      })
    );

    expect(replay(events)).toEqual({
      completeness: "invalid",
      steps: [],
      evidence: [expect.objectContaining({ code: "evidence-limit" })],
    });
  });

  it("fails closed when a producer/sequence group exceeds its fanout bound", () => {
    const events = Array.from({ length: 33 }, (_, index) =>
      journeyEvent({
        eventId: hex32(2_000 + index),
        spanId: hex16(2_000 + index),
      })
    );

    expect(replay(events)).toEqual({
      completeness: "invalid",
      steps: [],
      evidence: [expect.objectContaining({ code: "evidence-limit" })],
    });
  });
});

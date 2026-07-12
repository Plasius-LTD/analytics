import { describe, expect, it, vi } from "vitest";
import {
  defineSemanticJourneyCatalog,
  getJourneyEventDefinition,
  isJourneyToken,
  isSemanticToken,
  validateSemanticJourneyEventInput,
} from "../src/journey/catalog.js";
import {
  createChildJourneyContext,
  createEventId,
  createJourneyContext,
  createProducerId,
  createRequestJourneyContext,
  createSecureRandomHex,
  formatTraceparent,
  isEventId,
  isJourneyId,
  isProducerId,
  isSpanId,
  isTraceId,
  parseTraceparent,
  type RandomByteSource,
} from "../src/journey/context.js";

const catalogue = defineSemanticJourneyCatalog({
  "checkout.submit": {
    category: "interaction",
    targets: [{ type: "control", id: "checkout-submit" }],
    attributes: {
      validationState: {
        type: "enum",
        values: ["valid", "invalid", "unknown"],
      },
      retry: { type: "boolean" },
      attempt: { type: "number", min: 0, max: 3, integer: true },
    },
  },
  "checkout.open": {
    category: "presentation",
  },
}, { sources: ["site"] });

function expectSafeRejection(input: unknown, canary: string): void {
  let thrown: unknown;

  try {
    validateSemanticJourneyEventInput(
      catalogue,
      input as Parameters<typeof validateSemanticJourneyEventInput>[1]
    );
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(Error);
  expect(String(thrown)).not.toContain(canary);
}

describe("semantic journey catalogue", () => {
  it("uses a bounded low-entropy grammar for semantic tokens", () => {
    expect(isSemanticToken("checkout.submit")).toBe(true);
    expect(isJourneyToken("validationState")).toBe(true);
    expect(isSemanticToken("checkout_problem-2")).toBe(true);

    expect(isSemanticToken("")).toBe(false);
    expect(isSemanticToken("Checkout Submit")).toBe(false);
    expect(isSemanticToken("https://example.invalid/checkout")).toBe(false);
    expect(isSemanticToken("canary.person@example.invalid")).toBe(false);
    expect(isSemanticToken(`event.${"a".repeat(64)}`)).toBe(false);
  });

  it("normalizes only registered enum, boolean, and bounded-number attributes", () => {
    const validated = validateSemanticJourneyEventInput(catalogue, {
      name: "checkout.submit",
      category: "interaction",
      phase: "intent",
      outcome: "unknown",
      modality: "keyboard",
      target: { type: "control", id: "checkout-submit" },
      attributes: {
        validationState: "valid",
        retry: false,
        attempt: 2,
      },
    });

    expect(validated).toEqual({
      name: "checkout.submit",
      category: "interaction",
      phase: "intent",
      outcome: "unknown",
      modality: "keyboard",
      target: { type: "control", id: "checkout-submit" },
      attributes: {
        validationState: "valid",
        retry: false,
        attempt: 2,
      },
      droppedAttributeCount: 0,
    });
    expect(getJourneyEventDefinition(catalogue, "checkout.submit")?.category).toBe(
      "interaction"
    );
    expect(catalogue.sources).toEqual(["site"]);
    expect(Object.isFrozen(catalogue.sources)).toBe(true);
  });

  it("requires targets and sources to match immutable reviewed allowlists", () => {
    expectSafeRejection(
      {
        name: "checkout.submit",
        category: "interaction",
        phase: "intent",
        outcome: "unknown",
        target: { type: "control", id: "alice-synthetic" },
      },
      "alice-synthetic"
    );
    expect(() => defineSemanticJourneyCatalog({
      "safe.event": { category: "state" },
    }, { sources: ["site", "site"] })).toThrow(
      "Semantic journey catalogue definition is invalid."
    );
    expect(() => defineSemanticJourneyCatalog({
      "safe.event": { category: "state" },
    }, { sources: [] })).toThrow(
      "Semantic journey catalogue definition is invalid."
    );

    const sourceCanary = "synthetic-source-accessor-canary";
    const hostileOptions = Object.defineProperty({}, "sources", {
      enumerable: true,
      get: () => {
        throw new Error(sourceCanary);
      },
    });
    let thrown: unknown;
    try {
      defineSemanticJourneyCatalog(
        { "safe.event": { category: "state" } },
        hostileOptions as { sources: readonly string[] }
      );
    } catch (error) {
      thrown = error;
    }
    expect(String(thrown)).toBe(
      "Error: Semantic journey catalogue definition is invalid."
    );
    expect(String(thrown)).not.toContain(sourceCanary);
  });

  it("rejects unregistered attributes, free text, PII, credentials, and URLs without echoing values", () => {
    const emailCanary = "canary.person@example.invalid";
    const tokenCanary = "eyCanaryHeader.eyCanaryPayload.canary_signature";
    const urlCanary = "https://example.invalid/private?canary=value";
    const textCanary = "Synthetic Canary Person entered arbitrary prose";
    const unknownCanary = "ordinary-unregistered-value";

    expectSafeRejection(
      {
        name: "checkout.submit",
        category: "interaction",
        phase: "intent",
        outcome: "unknown",
        attributes: { email: emailCanary },
      },
      emailCanary
    );
    expectSafeRejection(
      {
        name: "checkout.submit",
        category: "interaction",
        phase: "intent",
        outcome: "unknown",
        attributes: { experimentCohort: unknownCanary },
      },
      unknownCanary
    );
    expectSafeRejection(
      {
        name: "checkout.submit",
        category: "interaction",
        phase: "intent",
        outcome: "unknown",
        attributes: { validationState: tokenCanary },
      },
      tokenCanary
    );
    expectSafeRejection(
      {
        name: "checkout.submit",
        category: "interaction",
        phase: "intent",
        outcome: "unknown",
        attributes: { validationState: urlCanary },
      },
      urlCanary
    );
    expectSafeRejection(
      {
        name: "checkout.submit",
        category: "interaction",
        phase: "intent",
        outcome: "unknown",
        attributes: { validationState: textCanary },
      },
      textCanary
    );
  });

  it("rejects unknown top-level and target fields without reading them into an error", () => {
    const bodyCanary = "request-body-canary-value";
    const selectorCanary = "#private-account-panel";

    expectSafeRejection(
      {
        name: "checkout.open",
        category: "presentation",
        phase: "effect",
        outcome: "success",
        requestBody: bodyCanary,
      },
      bodyCanary
    );
    expectSafeRejection(
      {
        name: "checkout.open",
        category: "presentation",
        phase: "effect",
        outcome: "success",
        target: {
          type: "dialog",
          id: "checkout-problem",
          selector: selectorCanary,
        },
      },
      selectorCanary
    );
  });

  it("converts hostile accessor failures into a generic non-echoing rejection", () => {
    const accessorCanary = "synthetic-accessor-private-canary";
    const attributes = Object.defineProperty({}, "validationState", {
      enumerable: true,
      get: () => {
        throw new Error(accessorCanary);
      },
    });

    expectSafeRejection(
      {
        name: "checkout.submit",
        category: "interaction",
        phase: "intent",
        outcome: "unknown",
        attributes,
      },
      accessorCanary
    );
  });

  it("rejects unsupported or unbounded attribute definitions", () => {
    expect(() =>
      defineSemanticJourneyCatalog({
        "unsafe.text": {
          category: "state",
          attributes: {
            detail: { type: "string" },
          },
        },
      } as never, { sources: ["site"] })
    ).toThrow("Semantic journey catalogue definition is invalid.");

    expect(() =>
      defineSemanticJourneyCatalog({
        "unsafe.number": {
          category: "state",
          attributes: {
            amount: { type: "number" },
          },
        },
      } as never, { sources: ["site"] })
    ).toThrow("Semantic journey catalogue definition is invalid.");
  });
});

describe("semantic journey causal context", () => {
  it("supports deterministic secure random-byte injection with the required ID widths", () => {
    let fill = 1;
    const requestedLengths: number[] = [];
    const randomBytes: RandomByteSource = (byteLength) => {
      requestedLengths.push(byteLength);
      return new Uint8Array(byteLength).fill(fill++);
    };

    expect(createSecureRandomHex(4, randomBytes)).toBe("01010101");

    const context = createJourneyContext(randomBytes);
    const eventId = createEventId(randomBytes);
    const producerId = createProducerId(randomBytes);

    expect(context.journeyId).toBe("02".repeat(16));
    expect(context.traceId).toBe("03".repeat(16));
    expect(context.spanId).toBe("04".repeat(8));
    expect(eventId).toBe("05".repeat(16));
    expect(producerId).toBe("06".repeat(8));
    expect(requestedLengths).toEqual([4, 16, 16, 8, 16, 8]);

    expect(isJourneyId(context.journeyId)).toBe(true);
    expect(isTraceId(context.traceId)).toBe(true);
    expect(isSpanId(context.spanId)).toBe(true);
    expect(isEventId(eventId)).toBe(true);
    expect(isProducerId(producerId)).toBe(true);
  });

  it("uses Web Crypto without consulting Math.random", () => {
    const mathRandom = vi.spyOn(Math, "random").mockImplementation(() => {
      throw new Error("Math.random must not be used");
    });

    try {
      expect(createEventId()).toMatch(/^[0-9a-f]{32}$/);
    } finally {
      mathRandom.mockRestore();
    }
  });

  it("creates child spans and fresh request traces without crossing the journey ID", () => {
    let fill = 10;
    const randomBytes: RandomByteSource = (byteLength) =>
      new Uint8Array(byteLength).fill(fill++);
    const root = createJourneyContext(randomBytes, "01");
    const child = createChildJourneyContext(root, randomBytes);
    const request = createRequestJourneyContext(child, randomBytes);

    expect(child.journeyId).toBe(root.journeyId);
    expect(child.traceId).toBe(root.traceId);
    expect(child.parentSpanId).toBe(root.spanId);
    expect(request.journeyId).toBe(root.journeyId);
    expect(request.traceId).not.toBe(child.traceId);
    expect(request.parentSpanId).toBeUndefined();

    const traceparent = formatTraceparent(request);
    expect(traceparent).toBe(
      `00-${request.traceId}-${request.spanId}-01`
    );
    expect(traceparent).not.toContain(root.journeyId);
    expect(JSON.stringify({ traceparent })).not.toContain(root.journeyId);
  });

  it("strictly parses W3C traceparent values", () => {
    const traceId = "ab".repeat(16);
    const spanId = "34".repeat(8);
    const traceparent = `00-${traceId}-${spanId}-01`;

    expect(parseTraceparent(traceparent)).toEqual({
      version: "00",
      traceId,
      spanId,
      traceFlags: "01",
    });

    expect(parseTraceparent(`01-${traceId}-${spanId}-01`)).toBeNull();
    expect(parseTraceparent(`00-${traceId.toUpperCase()}-${spanId}-01`)).toBeNull();
    expect(parseTraceparent(`00-${traceId}-${spanId}-02`)).toBeNull();
    expect(parseTraceparent(` ${traceparent}`)).toBeNull();
    expect(parseTraceparent(`${traceparent}-extra`)).toBeNull();
    expect(parseTraceparent(42)).toBeNull();
  });

  it("rejects malformed, all-zero, and incorrectly sized identifiers", () => {
    const traceId = "12".repeat(16);
    const spanId = "34".repeat(8);

    expect(isJourneyId("0".repeat(32))).toBe(false);
    expect(isTraceId("0".repeat(32))).toBe(false);
    expect(isEventId("0".repeat(32))).toBe(false);
    expect(isSpanId("0".repeat(16))).toBe(false);
    expect(isProducerId("0".repeat(16))).toBe(false);
    expect(isTraceId("12".repeat(15))).toBe(false);
    expect(isSpanId("GG".repeat(8))).toBe(false);

    expect(
      parseTraceparent(`00-${"0".repeat(32)}-${spanId}-01`)
    ).toBeNull();
    expect(
      parseTraceparent(`00-${traceId}-${"0".repeat(16)}-01`)
    ).toBeNull();
    expect(() =>
      formatTraceparent({
        traceId: "0".repeat(32),
        spanId,
        traceFlags: "01",
      })
    ).toThrow("Semantic journey trace context is invalid.");
  });

  it("bounds random requests and fails safely when a source emits only zero IDs", () => {
    const zeroBytes: RandomByteSource = (byteLength) =>
      new Uint8Array(byteLength);

    expect(() => createSecureRandomHex(0, zeroBytes)).toThrow(
      "Secure random byte length is invalid."
    );
    expect(() => createSecureRandomHex(65, zeroBytes)).toThrow(
      "Secure random byte length is invalid."
    );
    expect(() => createEventId(zeroBytes)).toThrow(
      "Secure random source did not produce a valid identifier."
    );
  });
});

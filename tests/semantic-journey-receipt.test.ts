import { describe, expect, it } from "vitest";

import { defineSemanticJourneyCatalog } from "../src/journey/catalog.js";
import {
  SEMANTIC_JOURNEY_RECEIPT_HEADER,
  parseSemanticJourneyReceipts,
  serializeSemanticJourneyReceipts,
  type SemanticJourneyConsequenceReceipt,
} from "../src/journey/receipt.js";

const LONG_EVENT_NAME = `bounded.${"a".repeat(42)}`;

const catalogue = defineSemanticJourneyCatalog({
  "backend.command": {
    category: "command",
    attributes: {},
    effects: ["state.changed"],
  },
  "frontend.presentation": {
    category: "presentation",
    attributes: {},
    effects: ["problem.shown"],
  },
  [LONG_EVENT_NAME]: {
    category: "state",
    attributes: {},
    effects: [`effect.${"b".repeat(42)}`],
  },
}, { sources: ["site"] });

function consequence(
  overrides: Partial<SemanticJourneyConsequenceReceipt> = {}
): SemanticJourneyConsequenceReceipt {
  return {
    version: "1",
    name: "backend.command",
    outcome: "success",
    phase: "end",
    effect: "state.changed",
    ...overrides,
  };
}

describe("semantic journey consequence receipts", () => {
  it("uses a canonical ASCII token-only header and round-trips known consequences", () => {
    const receipts = [
      consequence(),
      consequence({
        name: "frontend.presentation",
        outcome: "denied",
        phase: "effect",
        effect: "problem.shown",
      }),
    ];

    const header = serializeSemanticJourneyReceipts(receipts, catalogue);

    expect(SEMANTIC_JOURNEY_RECEIPT_HEADER).toBe("x-plasius-journey-receipt");
    expect(header).toBe(
      "version=1;name=backend.command;outcome=success;phase=end;effect=state.changed,"
      + "version=1;name=frontend.presentation;outcome=denied;phase=effect;effect=problem.shown"
    );
    expect(header).toMatch(/^[\x21-\x7e]+$/);
    expect(parseSemanticJourneyReceipts(header, catalogue)).toEqual(receipts);
  });

  it("rejects malformed, non-canonical, unknown, or unsafe input as one unit", () => {
    const valid = serializeSemanticJourneyReceipts([consequence()], catalogue);
    const malformed = [
      `${valid};body=PRIVATE_CANARY`,
      valid.replace(";effect=", ";effect=first;effect="),
      valid.replace("version=1;name=", "name=backend.command;version=1;name="),
      valid.replace(";phase=end", ""),
      valid.replace("version=1", "version=2"),
      valid.replace("outcome=success", "outcome=unexpected"),
      valid.replace("name=backend.command", "name=unknown.command"),
      valid.replace("effect=state.changed", "effect=invalid@PRIVATE_CANARY"),
      valid.replace("effect=state.changed", "effect=alice-synthetic"),
      `${valid}\r\nPRIVATE_CANARY`,
      ` ${valid}`,
    ];

    for (const header of malformed) {
      expect(parseSemanticJourneyReceipts(header, catalogue)).toEqual([]);
    }
  });

  it("enforces four-receipt and 512-byte limits before accepting input", () => {
    const five = Array.from({ length: 5 }, () => consequence());
    expect(() => serializeSemanticJourneyReceipts(five, catalogue)).toThrow(
      "Invalid semantic journey receipt."
    );

    const longReceipt = consequence({
      name: LONG_EVENT_NAME,
      effect: `effect.${"b".repeat(42)}`,
    });
    expect(() => serializeSemanticJourneyReceipts(
      [longReceipt, longReceipt, longReceipt, longReceipt],
      catalogue
    )).toThrow("Invalid semantic journey receipt.");

    const overCountHeader = Array.from({ length: 5 }, () =>
      "version=1;name=backend.command;outcome=success;phase=end;effect=state.changed"
    ).join(",");
    expect(parseSemanticJourneyReceipts(overCountHeader, catalogue)).toEqual([]);
    expect(parseSemanticJourneyReceipts("a".repeat(513), catalogue)).toEqual([]);
  });

  it("throws only a generic message for invalid trusted serialization input", () => {
    const invalid = {
      ...consequence(),
      effect: "invalid@PRIVATE_CANARY",
      body: "PRIVATE_CANARY",
    } as unknown as SemanticJourneyConsequenceReceipt;

    let thrown: unknown;
    try {
      serializeSemanticJourneyReceipts([invalid], catalogue);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("Invalid semantic journey receipt.");
    expect((thrown as Error).message).not.toContain("PRIVATE_CANARY");
  });

  it("treats absent receipts as empty without fabricating evidence", () => {
    expect(serializeSemanticJourneyReceipts([], catalogue)).toBe("");
    expect(parseSemanticJourneyReceipts(undefined, catalogue)).toEqual([]);
    expect(parseSemanticJourneyReceipts(null, catalogue)).toEqual([]);
    expect(parseSemanticJourneyReceipts("", catalogue)).toEqual([]);
  });
});

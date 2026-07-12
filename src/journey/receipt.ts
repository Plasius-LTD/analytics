import {
  getJourneyEventDefinition,
  isJourneyToken,
  type SemanticJourneyCatalogue,
} from "./catalog.js";
import type { SemanticJourneyEventInput } from "./types.js";

/** Response header carrying bounded semantic backend consequences. */
export const SEMANTIC_JOURNEY_RECEIPT_HEADER = "x-plasius-journey-receipt";
/** Current consequence receipt format version. */
export const SEMANTIC_JOURNEY_RECEIPT_VERSION = "1" as const;
/** Maximum number of consequences permitted in one response header. */
export const SEMANTIC_JOURNEY_RECEIPT_MAX_COUNT = 4;
/** Maximum encoded consequence header size. */
export const SEMANTIC_JOURNEY_RECEIPT_MAX_BYTES = 512;

type ReceiptOutcome = SemanticJourneyEventInput["outcome"];
type ReceiptPhase = SemanticJourneyEventInput["phase"];

/** A catalogue-controlled backend consequence safe to return to a client. */
export interface SemanticJourneyConsequenceReceipt {
  readonly version: typeof SEMANTIC_JOURNEY_RECEIPT_VERSION;
  readonly name: string;
  readonly outcome: ReceiptOutcome;
  readonly phase: ReceiptPhase;
  readonly effect: string;
}

const RECEIPT_FIELDS = [
  "version",
  "name",
  "outcome",
  "phase",
  "effect",
] as const;

const RECEIPT_OUTCOMES: readonly ReceiptOutcome[] = [
  "unknown",
  "success",
  "failure",
  "cancelled",
  "denied",
];

const RECEIPT_PHASES: readonly ReceiptPhase[] = [
  "intent",
  "start",
  "progress",
  "end",
  "effect",
];

const VISIBLE_ASCII = /^[\x21-\x7e]+$/;
const SERIALIZE_ERROR_MESSAGE = "Invalid semantic journey receipt.";

function isReceiptOutcome(value: unknown): value is ReceiptOutcome {
  return typeof value === "string"
    && RECEIPT_OUTCOMES.includes(value as ReceiptOutcome);
}

function isReceiptPhase(value: unknown): value is ReceiptPhase {
  return typeof value === "string"
    && RECEIPT_PHASES.includes(value as ReceiptPhase);
}

function hasCanonicalFields(value: object): boolean {
  const keys = Object.keys(value);
  return keys.length === RECEIPT_FIELDS.length
    && RECEIPT_FIELDS.every((field) => keys.includes(field));
}

function isValidReceipt(
  value: unknown,
  catalogue: SemanticJourneyCatalogue
): value is SemanticJourneyConsequenceReceipt {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || !hasCanonicalFields(value)
  ) {
    return false;
  }

  const receipt = value as Partial<SemanticJourneyConsequenceReceipt>;
  const definition = isJourneyToken(receipt.name)
    ? getJourneyEventDefinition(catalogue, receipt.name)
    : undefined;
  return receipt.version === SEMANTIC_JOURNEY_RECEIPT_VERSION
    && definition !== undefined
    && isReceiptOutcome(receipt.outcome)
    && isReceiptPhase(receipt.phase)
    && isJourneyToken(receipt.effect)
    && (definition.effects ?? []).includes(receipt.effect);
}

function serializeReceipt(receipt: SemanticJourneyConsequenceReceipt): string {
  return `version=${receipt.version};name=${receipt.name};outcome=${receipt.outcome};phase=${receipt.phase};effect=${receipt.effect}`;
}

function parseCanonicalField(field: string, expectedName: string): string | undefined {
  const prefix = `${expectedName}=`;
  if (!field.startsWith(prefix)) {
    return undefined;
  }

  const value = field.slice(prefix.length);
  return value.length > 0 && !value.includes("=") ? value : undefined;
}

function parseReceipt(
  encoded: string,
  catalogue: SemanticJourneyCatalogue
): SemanticJourneyConsequenceReceipt | undefined {
  const fields = encoded.split(";");
  if (fields.length !== RECEIPT_FIELDS.length) {
    return undefined;
  }

  const version = parseCanonicalField(fields[0] ?? "", "version");
  const name = parseCanonicalField(fields[1] ?? "", "name");
  const outcome = parseCanonicalField(fields[2] ?? "", "outcome");
  const phase = parseCanonicalField(fields[3] ?? "", "phase");
  const effect = parseCanonicalField(fields[4] ?? "", "effect");

  const candidate: unknown = { version, name, outcome, phase, effect };
  return isValidReceipt(candidate, catalogue) ? candidate : undefined;
}

/**
 * Serializes trusted backend consequence codes into a canonical bounded header.
 * Invalid developer input fails with a generic error that never includes the
 * rejected value.
 */
export function serializeSemanticJourneyReceipts(
  receipts: readonly SemanticJourneyConsequenceReceipt[],
  catalogue: SemanticJourneyCatalogue
): string {
  try {
    if (
      !Array.isArray(receipts)
      || receipts.length > SEMANTIC_JOURNEY_RECEIPT_MAX_COUNT
      || !receipts.every((receipt) => isValidReceipt(receipt, catalogue))
    ) {
      throw new Error(SERIALIZE_ERROR_MESSAGE);
    }

    const header = receipts.map(serializeReceipt).join(",");
    if (header.length > SEMANTIC_JOURNEY_RECEIPT_MAX_BYTES) {
      throw new Error(SERIALIZE_ERROR_MESSAGE);
    }

    return header;
  } catch {
    throw new Error(SERIALIZE_ERROR_MESSAGE);
  }
}

/**
 * Parses an untrusted consequence header with all-or-nothing validation.
 * Missing or malformed input returns an empty list and is never reflected in an
 * exception, log message, or result value.
 */
export function parseSemanticJourneyReceipts(
  header: string | null | undefined,
  catalogue: SemanticJourneyCatalogue
): SemanticJourneyConsequenceReceipt[] {
  if (typeof header !== "string" || header.length === 0) {
    return [];
  }

  if (
    header.length > SEMANTIC_JOURNEY_RECEIPT_MAX_BYTES
    || !VISIBLE_ASCII.test(header)
  ) {
    return [];
  }

  try {
    const encodedReceipts = header.split(",");
    if (encodedReceipts.length > SEMANTIC_JOURNEY_RECEIPT_MAX_COUNT) {
      return [];
    }

    const receipts: SemanticJourneyConsequenceReceipt[] = [];
    for (const encoded of encodedReceipts) {
      const receipt = parseReceipt(encoded, catalogue);
      if (!receipt) {
        return [];
      }
      receipts.push(receipt);
    }

    return receipts;
  } catch {
    return [];
  }
}

import type {
  SemanticJourneyContext,
  SemanticJourneyTraceContext,
  SemanticJourneyTraceFlags,
} from "./types.js";

const MAX_RANDOM_BYTE_LENGTH = 64;
const MAX_IDENTIFIER_ATTEMPTS = 8;
const TRACE_ID_HEX_LENGTH = 32;
const SPAN_ID_HEX_LENGTH = 16;
const ALL_ZERO_TRACE_ID = "0".repeat(TRACE_ID_HEX_LENGTH);
const ALL_ZERO_SPAN_ID = "0".repeat(SPAN_ID_HEX_LENGTH);
const TRACEPARENT_PATTERN =
  /^00-([0-9a-f]{32})-([0-9a-f]{16})-(00|01)$/;

/** Injectable cryptographically secure byte source used by ID generators. */
export type RandomByteSource = (byteLength: number) => Uint8Array;

function webCryptoRandomBytes(byteLength: number): Uint8Array {
  const webCrypto = globalThis.crypto;
  if (webCrypto === undefined || typeof webCrypto.getRandomValues !== "function") {
    throw new Error("Secure random source is unavailable.");
  }

  return webCrypto.getRandomValues(new Uint8Array(byteLength));
}

/**
 * Creates lowercase random hex using global Web Crypto or an injected secure
 * source. Requests are deliberately bounded to prevent accidental allocation.
 */
export function createSecureRandomHex(
  byteLength: number,
  randomBytes: RandomByteSource = webCryptoRandomBytes
): string {
  if (
    !Number.isSafeInteger(byteLength) ||
    byteLength <= 0 ||
    byteLength > MAX_RANDOM_BYTE_LENGTH
  ) {
    throw new Error("Secure random byte length is invalid.");
  }

  const bytes = randomBytes(byteLength);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== byteLength) {
    throw new Error("Secure random source returned invalid bytes.");
  }

  let result = "";
  for (const byte of bytes) {
    result += byte.toString(16).padStart(2, "0");
  }
  return result;
}

function createNonZeroIdentifier(
  byteLength: number,
  randomBytes?: RandomByteSource
): string {
  for (let attempt = 0; attempt < MAX_IDENTIFIER_ATTEMPTS; attempt += 1) {
    const identifier = createSecureRandomHex(
      byteLength,
      randomBytes ?? webCryptoRandomBytes
    );
    if (!/^0+$/.test(identifier)) {
      return identifier;
    }
  }

  throw new Error("Secure random source did not produce a valid identifier.");
}

function isNonZeroLowerHex(value: unknown, length: number): value is string {
  return (
    typeof value === "string" &&
    value.length === length &&
    /^[0-9a-f]+$/.test(value) &&
    !/^0+$/.test(value)
  );
}

/** Creates a 32-hex, non-zero local journey identifier. */
export function createJourneyId(randomBytes?: RandomByteSource): string {
  return createNonZeroIdentifier(16, randomBytes);
}

/** Creates a 32-hex, non-zero W3C trace identifier. */
export function createTraceId(randomBytes?: RandomByteSource): string {
  return createNonZeroIdentifier(16, randomBytes);
}

/** Creates a 32-hex, non-zero semantic event identifier. */
export function createEventId(randomBytes?: RandomByteSource): string {
  return createNonZeroIdentifier(16, randomBytes);
}

/** Creates a 16-hex, non-zero W3C span identifier. */
export function createSpanId(randomBytes?: RandomByteSource): string {
  return createNonZeroIdentifier(8, randomBytes);
}

/** Creates a 16-hex, non-zero runtime producer identifier. */
export function createProducerId(randomBytes?: RandomByteSource): string {
  return createNonZeroIdentifier(8, randomBytes);
}

/** Returns whether a value is a valid 32-hex, non-zero journey identifier. */
export function isJourneyId(value: unknown): value is string {
  return isNonZeroLowerHex(value, TRACE_ID_HEX_LENGTH);
}

/** Returns whether a value is a valid 32-hex, non-zero trace identifier. */
export function isTraceId(value: unknown): value is string {
  return isNonZeroLowerHex(value, TRACE_ID_HEX_LENGTH);
}

/** Returns whether a value is a valid 32-hex, non-zero event identifier. */
export function isEventId(value: unknown): value is string {
  return isNonZeroLowerHex(value, TRACE_ID_HEX_LENGTH);
}

/** Returns whether a value is a valid 16-hex, non-zero span identifier. */
export function isSpanId(value: unknown): value is string {
  return isNonZeroLowerHex(value, SPAN_ID_HEX_LENGTH);
}

/** Returns whether a value is a valid 16-hex, non-zero producer identifier. */
export function isProducerId(value: unknown): value is string {
  return isNonZeroLowerHex(value, SPAN_ID_HEX_LENGTH);
}

function isTraceFlags(value: unknown): value is SemanticJourneyTraceFlags {
  return value === "00" || value === "01";
}

function assertLocalContext(context: SemanticJourneyContext): void {
  if (
    !isJourneyId(context.journeyId) ||
    !isTraceId(context.traceId) ||
    !isSpanId(context.spanId) ||
    (context.parentSpanId !== undefined && !isSpanId(context.parentSpanId)) ||
    !isTraceFlags(context.traceFlags)
  ) {
    throw new Error("Semantic journey causal context is invalid.");
  }
}

/** Creates a new local-private journey and its root trace/span context. */
export function createJourneyContext(
  randomBytes?: RandomByteSource,
  traceFlags: SemanticJourneyTraceFlags = "00"
): SemanticJourneyContext {
  if (!isTraceFlags(traceFlags)) {
    throw new Error("Semantic journey causal context is invalid.");
  }

  return Object.freeze({
    journeyId: createJourneyId(randomBytes),
    traceId: createTraceId(randomBytes),
    spanId: createSpanId(randomBytes),
    traceFlags,
  });
}

/** Creates a child span while retaining the local journey and trace. */
export function createChildJourneyContext(
  parent: SemanticJourneyContext,
  randomBytes?: RandomByteSource
): SemanticJourneyContext {
  assertLocalContext(parent);
  return Object.freeze({
    journeyId: parent.journeyId,
    traceId: parent.traceId,
    spanId: createSpanId(randomBytes),
    parentSpanId: parent.spanId,
    traceFlags: parent.traceFlags,
  });
}

/**
 * Creates a request-scoped trace for an outbound request. Cross-request
 * causality remains local; only this fresh traceparent crosses the boundary.
 */
export function createRequestJourneyContext(
  parent: SemanticJourneyContext,
  randomBytes?: RandomByteSource
): SemanticJourneyContext {
  assertLocalContext(parent);
  return Object.freeze({
    journeyId: parent.journeyId,
    traceId: createTraceId(randomBytes),
    spanId: createSpanId(randomBytes),
    traceFlags: parent.traceFlags,
  });
}

/** Formats a strict W3C traceparent without serializing any local journey ID. */
export function formatTraceparent(
  context: Pick<
    SemanticJourneyTraceContext,
    "traceId" | "spanId" | "traceFlags"
  >
): string {
  if (
    !isTraceId(context.traceId) ||
    !isSpanId(context.spanId) ||
    !isTraceFlags(context.traceFlags)
  ) {
    throw new Error("Semantic journey trace context is invalid.");
  }

  return `00-${context.traceId}-${context.spanId}-${context.traceFlags}`;
}

/**
 * Strictly parses a version-00 W3C traceparent. Malformed or all-zero inbound
 * identifiers return `null` so callers can safely restart the context.
 */
export function parseTraceparent(value: unknown): SemanticJourneyTraceContext | null {
  if (typeof value !== "string") {
    return null;
  }

  const match = TRACEPARENT_PATTERN.exec(value);
  if (match === null) {
    return null;
  }

  const traceId = match[1];
  const spanId = match[2];
  const traceFlags = match[3];
  if (
    traceId === undefined ||
    spanId === undefined ||
    traceFlags === undefined ||
    traceId === ALL_ZERO_TRACE_ID ||
    spanId === ALL_ZERO_SPAN_ID ||
    !isTraceId(traceId) ||
    !isSpanId(spanId) ||
    !isTraceFlags(traceFlags)
  ) {
    return null;
  }

  return Object.freeze({
    version: "00",
    traceId,
    spanId,
    traceFlags,
  });
}

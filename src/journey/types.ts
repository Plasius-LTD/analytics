/** A cryptographically random, episode-scoped journey identifier. */
export type SemanticJourneyId = string;

/** A W3C-compatible trace identifier. */
export type SemanticJourneyTraceId = string;

/** A W3C-compatible span identifier. */
export type SemanticJourneySpanId = string;

/** A cryptographically random semantic event identifier. */
export type SemanticJourneyEventId = string;

/** A cryptographically random, runtime-local producer identifier. */
export type SemanticJourneyProducerId = string;

/** Package-owned strict privacy policy version used by every v2 event/batch. */
export const SEMANTIC_JOURNEY_STRICT_POLICY_VERSION = "strict.v1" as const;

/** The bounded categories understood by semantic journey reconstruction. */
export type SemanticJourneyCategory =
  | "interaction"
  | "navigation"
  | "request"
  | "command"
  | "state"
  | "presentation"
  | "dependency"
  | "error";

/** The lifecycle phase represented by a semantic event. */
export type SemanticJourneyPhase =
  | "intent"
  | "start"
  | "progress"
  | "end"
  | "effect";

/** The bounded outcome represented by a semantic event. */
export type SemanticJourneyOutcome =
  | "unknown"
  | "success"
  | "failure"
  | "cancelled"
  | "denied";

/** A privacy-safe interaction modality. */
export type SemanticJourneyModality =
  | "pointer"
  | "keyboard"
  | "touch"
  | "voice"
  | "gesture"
  | "system";

/** A catalogue-controlled semantic target. It never contains DOM-derived text. */
export interface SemanticJourneyTarget {
  readonly type: string;
  readonly id: string;
}

/** The only value kinds admitted to semantic event attributes. */
export type SemanticJourneyAttributeValue = boolean | number | string;

/** Privacy evidence attached to every accepted semantic event. */
export interface SemanticJourneyPrivacyMetadata {
  readonly mode: "strict";
  readonly policyVersion: typeof SEMANTIC_JOURNEY_STRICT_POLICY_VERSION;
  readonly droppedAttributeCount: number;
}

/**
 * Version 2 semantic evidence. This is additive to the legacy
 * `LocalSpaceAnalyticsEvent` contract and intentionally contains no arbitrary
 * context object.
 */
export interface SemanticJourneyEvent {
  readonly schemaVersion: "2.0";
  readonly eventId: SemanticJourneyEventId;
  readonly journeyId: SemanticJourneyId;
  readonly traceId: SemanticJourneyTraceId;
  readonly spanId: SemanticJourneySpanId;
  readonly parentSpanId?: SemanticJourneySpanId;
  readonly causedByEventId?: SemanticJourneyEventId;
  readonly producerId: SemanticJourneyProducerId;
  readonly producerSequence: number;
  readonly occurredAtEpochMs: number;
  readonly source: string;
  readonly channel: "frontend" | "backend";
  readonly runtime: "browser" | "server";
  readonly name: string;
  readonly category: SemanticJourneyCategory;
  readonly phase: SemanticJourneyPhase;
  readonly outcome: SemanticJourneyOutcome;
  readonly modality?: SemanticJourneyModality;
  readonly target?: SemanticJourneyTarget;
  readonly attributes: Readonly<Record<string, SemanticJourneyAttributeValue>>;
  readonly privacy: SemanticJourneyPrivacyMetadata;
}

/** Input accepted by the strict semantic catalogue validator. */
export interface SemanticJourneyEventInput {
  name: string;
  category: SemanticJourneyCategory;
  phase: SemanticJourneyPhase;
  outcome: SemanticJourneyOutcome;
  modality?: SemanticJourneyModality;
  target?: SemanticJourneyTarget;
  attributes?: Readonly<Record<string, unknown>>;
}

/** A normalized input proven to conform to one catalogue definition. */
export interface ValidatedSemanticJourneyEventInput {
  name: string;
  category: SemanticJourneyCategory;
  phase: SemanticJourneyPhase;
  outcome: SemanticJourneyOutcome;
  modality?: SemanticJourneyModality;
  target?: SemanticJourneyTarget;
  attributes: Readonly<Record<string, SemanticJourneyAttributeValue>>;
  droppedAttributeCount: 0;
}

/** A registered, bounded enum attribute. */
export interface SemanticJourneyEnumAttributeDefinition {
  type: "enum";
  values: readonly string[];
}

/** A registered boolean attribute. */
export interface SemanticJourneyBooleanAttributeDefinition {
  type: "boolean";
}

/** A registered number with mandatory finite lower and upper bounds. */
export interface SemanticJourneyNumberAttributeDefinition {
  type: "number";
  min: number;
  max: number;
  integer?: boolean;
}

/** The closed set of supported catalogue attribute definitions. */
export type SemanticJourneyAttributeDefinition =
  | SemanticJourneyEnumAttributeDefinition
  | SemanticJourneyBooleanAttributeDefinition
  | SemanticJourneyNumberAttributeDefinition;

/** A semantic event definition registered by application developers. */
export interface SemanticJourneyEventDefinition {
  readonly category: SemanticJourneyCategory;
  readonly attributes?: Readonly<Record<string, SemanticJourneyAttributeDefinition>>;
  readonly targets?: readonly SemanticJourneyTarget[];
  readonly effects?: readonly string[];
}

/** Reviewed, immutable dimensions shared by one semantic catalogue. */
export interface SemanticJourneyCatalogOptions {
  readonly sources: readonly string[];
}

/** An immutable, validated collection of semantic event definitions. */
export interface SemanticJourneyCatalog {
  readonly sources: readonly string[];
  readonly definitions: Readonly<
    Record<string, Readonly<SemanticJourneyEventDefinition>>
  >;
}

/** British-English compatibility alias for `SemanticJourneyCatalog`. */
export type SemanticJourneyCatalogue = SemanticJourneyCatalog;

/** W3C trace flags supported by the strict journey context parser. */
export type SemanticJourneyTraceFlags = "00" | "01";

/** A strictly parsed W3C traceparent context. */
export interface SemanticJourneyTraceContext {
  version: "00";
  traceId: SemanticJourneyTraceId;
  spanId: SemanticJourneySpanId;
  traceFlags: SemanticJourneyTraceFlags;
}

/**
 * Local causal context. `journeyId` is private to the runtime and is never
 * included by traceparent formatting.
 */
export interface SemanticJourneyContext {
  journeyId: SemanticJourneyId;
  traceId: SemanticJourneyTraceId;
  spanId: SemanticJourneySpanId;
  parentSpanId?: SemanticJourneySpanId;
  traceFlags: SemanticJourneyTraceFlags;
}

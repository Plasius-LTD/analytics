import type {
  SemanticJourneyAttributeDefinition,
  SemanticJourneyAttributeValue,
  SemanticJourneyCatalog,
  SemanticJourneyCatalogOptions,
  SemanticJourneyCategory,
  SemanticJourneyEventDefinition,
  SemanticJourneyEventInput,
  SemanticJourneyModality,
  SemanticJourneyOutcome,
  SemanticJourneyPhase,
  SemanticJourneyTarget,
  ValidatedSemanticJourneyEventInput,
} from "./types.js";

export type {
  SemanticJourneyCatalog,
  SemanticJourneyCatalogue,
} from "./types.js";

const MAX_TOKEN_LENGTH = 64;
const MAX_TOKEN_SEGMENTS = 8;
const MAX_TOKEN_SEGMENT_LENGTH = MAX_TOKEN_LENGTH;
const MAX_CATALOG_EVENTS = 2048;
const MAX_EVENT_ATTRIBUTES = 32;
const MAX_ENUM_VALUES = 64;
const MAX_CATALOG_SOURCES = 64;
const MAX_EVENT_TARGETS = 64;
const MAX_EVENT_EFFECTS = 64;

const TOKEN_PATTERN = /^[a-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)*$/;
const HIGH_ENTROPY_HEX_PATTERN = /^[a-f0-9]{16,}$/i;
const HIGH_ENTROPY_TOKEN_PATTERN =
  /^(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{24,}$/;

const CATEGORIES = new Set<SemanticJourneyCategory>([
  "interaction",
  "navigation",
  "request",
  "command",
  "state",
  "presentation",
  "dependency",
  "error",
]);
const PHASES = new Set<SemanticJourneyPhase>([
  "intent",
  "start",
  "progress",
  "end",
  "effect",
]);
const OUTCOMES = new Set<SemanticJourneyOutcome>([
  "unknown",
  "success",
  "failure",
  "cancelled",
  "denied",
]);
const MODALITIES = new Set<SemanticJourneyModality>([
  "pointer",
  "keyboard",
  "touch",
  "voice",
  "gesture",
  "system",
]);

const SENSITIVE_WORDS = new Set([
  "account",
  "address",
  "auth",
  "authentication",
  "authorization",
  "body",
  "browser",
  "chat",
  "clipboard",
  "content",
  "cookie",
  "credential",
  "database",
  "device",
  "digest",
  "dob",
  "editor",
  "email",
  "exception",
  "file",
  "fingerprint",
  "fragment",
  "generated",
  "hash",
  "html",
  "href",
  "input",
  "ip",
  "label",
  "latitude",
  "location",
  "log",
  "longitude",
  "message",
  "name",
  "password",
  "payload",
  "phone",
  "prompt",
  "query",
  "recording",
  "referrer",
  "requestbody",
  "responsebody",
  "screenshot",
  "secret",
  "selector",
  "session",
  "stack",
  "telephone",
  "textarea",
  "token",
  "transcript",
  "uri",
  "url",
  "user",
  "userid",
  "useragent",
  "username",
]);

const EVENT_INPUT_FIELDS = new Set([
  "name",
  "category",
  "phase",
  "outcome",
  "modality",
  "target",
  "attributes",
]);
const EVENT_DEFINITION_FIELDS = new Set([
  "category",
  "attributes",
  "targets",
  "effects",
]);
const TARGET_FIELDS = new Set(["type", "id"]);
const CATALOG_OPTIONS_FIELDS = new Set(["sources"]);

/** Stable, non-sensitive validation reason codes suitable for control flow. */
export type SemanticJourneyValidationErrorCode =
  | "invalid-input"
  | "invalid-token";

/** An intentionally generic error that never embeds rejected input. */
export class SemanticJourneyValidationError extends Error {
  readonly code: SemanticJourneyValidationErrorCode;

  constructor(code: SemanticJourneyValidationErrorCode) {
    super(
      code === "invalid-token"
        ? "Semantic journey token is invalid."
        : "Semantic journey input is invalid."
    );
    this.name = "SemanticJourneyValidationError";
    this.code = code;
  }
}

function invalidDefinition(): never {
  throw new Error("Semantic journey catalogue definition is invalid.");
}

function invalidInput(): never {
  throw new SemanticJourneyValidationError("invalid-input");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function getOwnStringKeys(value: Record<string, unknown>): string[] | null {
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) {
    return null;
  }

  return keys as string[];
}

function hasOnlyFields(keys: readonly string[], allowed: ReadonlySet<string>): boolean {
  return keys.every((key) => allowed.has(key));
}

function sensitivityWords(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.toLowerCase());
}

function looksSensitive(value: string): boolean {
  const words = sensitivityWords(value);
  const collapsed = words.join("");

  if (
    words.some((word) => SENSITIVE_WORDS.has(word)) ||
    SENSITIVE_WORDS.has(collapsed)
  ) {
    return true;
  }

  return (
    value.includes("@") ||
    value.includes("://") ||
    HIGH_ENTROPY_HEX_PATTERN.test(value) ||
    HIGH_ENTROPY_TOKEN_PATTERN.test(value)
  );
}

/** Returns whether a value conforms to the bounded semantic token grammar. */
export function isSemanticToken(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_TOKEN_LENGTH ||
    !TOKEN_PATTERN.test(value)
  ) {
    return false;
  }

  const segments = value.split(/[._-]/);
  return (
    segments.length <= MAX_TOKEN_SEGMENTS &&
    segments.every(
      (segment) =>
        segment.length > 0 && segment.length <= MAX_TOKEN_SEGMENT_LENGTH
    )
  );
}

/** Compatibility alias for `isSemanticToken`. */
export const isJourneyToken = isSemanticToken;

/** Returns whether a source name uses the bounded semantic token grammar. */
export const isSemanticSource = isSemanticToken;

/** Asserts the bounded token grammar without embedding the rejected value. */
export function assertSemanticToken(
  value: unknown,
  _field?: string
): asserts value is string {
  if (!isSemanticToken(value)) {
    throw new SemanticJourneyValidationError("invalid-token");
  }
}

/** Asserts the source token grammar without embedding the rejected value. */
export const assertSemanticSource = assertSemanticToken;

function normalizeAttributeDefinition(
  attributeName: string,
  candidate: unknown
): Readonly<SemanticJourneyAttributeDefinition> {
  if (!isSemanticToken(attributeName) || looksSensitive(attributeName)) {
    return invalidDefinition();
  }

  if (!isRecord(candidate)) {
    return invalidDefinition();
  }

  const keys = getOwnStringKeys(candidate);
  if (keys === null || typeof candidate.type !== "string") {
    return invalidDefinition();
  }

  if (candidate.type === "boolean") {
    if (keys.length !== 1 || keys[0] !== "type") {
      return invalidDefinition();
    }
    return Object.freeze({ type: "boolean" });
  }

  if (candidate.type === "enum") {
    if (
      !hasOnlyFields(keys, new Set(["type", "values"])) ||
      keys.length !== 2 ||
      !Array.isArray(candidate.values) ||
      candidate.values.length === 0 ||
      candidate.values.length > MAX_ENUM_VALUES
    ) {
      return invalidDefinition();
    }

    const values: string[] = [];
    const seen = new Set<string>();
    for (const value of candidate.values) {
      if (
        !isSemanticToken(value) ||
        looksSensitive(value) ||
        seen.has(value)
      ) {
        return invalidDefinition();
      }
      seen.add(value);
      values.push(value);
    }

    return Object.freeze({
      type: "enum",
      values: Object.freeze(values),
    });
  }

  if (candidate.type === "number") {
    if (
      !hasOnlyFields(keys, new Set(["type", "min", "max", "integer"])) ||
      !keys.includes("min") ||
      !keys.includes("max") ||
      typeof candidate.min !== "number" ||
      !Number.isFinite(candidate.min) ||
      typeof candidate.max !== "number" ||
      !Number.isFinite(candidate.max) ||
      candidate.min > candidate.max ||
      (candidate.integer !== undefined && typeof candidate.integer !== "boolean")
    ) {
      return invalidDefinition();
    }

    if (
      candidate.integer === true &&
      (!Number.isSafeInteger(candidate.min) || !Number.isSafeInteger(candidate.max))
    ) {
      return invalidDefinition();
    }

    return Object.freeze({
      type: "number",
      min: candidate.min,
      max: candidate.max,
      ...(candidate.integer === undefined
        ? {}
        : { integer: candidate.integer }),
    });
  }

  return invalidDefinition();
}

function normalizeEventDefinition(
  candidate: unknown
): Readonly<SemanticJourneyEventDefinition> {
  if (!isRecord(candidate)) {
    return invalidDefinition();
  }

  const keys = getOwnStringKeys(candidate);
  if (
    keys === null ||
    !hasOnlyFields(keys, EVENT_DEFINITION_FIELDS) ||
    !CATEGORIES.has(candidate.category as SemanticJourneyCategory)
  ) {
    return invalidDefinition();
  }

  const attributes: Record<string, SemanticJourneyAttributeDefinition> =
    Object.create(null) as Record<string, SemanticJourneyAttributeDefinition>;
  const candidateAttributes = candidate.attributes;
  if (candidateAttributes !== undefined) {
    if (!isRecord(candidateAttributes)) {
      return invalidDefinition();
    }
    const attributeNames = getOwnStringKeys(candidateAttributes);
    if (
      attributeNames === null ||
      attributeNames.length > MAX_EVENT_ATTRIBUTES
    ) {
      return invalidDefinition();
    }
    for (const attributeName of attributeNames) {
      attributes[attributeName] = normalizeAttributeDefinition(
        attributeName,
        candidateAttributes[attributeName]
      );
    }
  }

  const targets: SemanticJourneyTarget[] = [];
  if (candidate.targets !== undefined) {
    if (
      !Array.isArray(candidate.targets) ||
      candidate.targets.length > MAX_EVENT_TARGETS
    ) {
      return invalidDefinition();
    }
    const seenTargets = new Set<string>();
    for (const target of candidate.targets) {
      if (!isRecord(target)) {
        return invalidDefinition();
      }
      const targetKeys = getOwnStringKeys(target);
      if (
        targetKeys === null ||
        targetKeys.length !== 2 ||
        !hasOnlyFields(targetKeys, TARGET_FIELDS) ||
        !isSemanticToken(target.type) ||
        !isSemanticToken(target.id) ||
        looksSensitive(target.type) ||
        looksSensitive(target.id)
      ) {
        return invalidDefinition();
      }
      const key = `${target.type}\u0000${target.id}`;
      if (seenTargets.has(key)) {
        return invalidDefinition();
      }
      seenTargets.add(key);
      targets.push(Object.freeze({ type: target.type, id: target.id }));
    }
  }

  const effects: string[] = [];
  if (candidate.effects !== undefined) {
    if (
      !Array.isArray(candidate.effects) ||
      candidate.effects.length > MAX_EVENT_EFFECTS
    ) {
      return invalidDefinition();
    }
    const seenEffects = new Set<string>();
    for (const effect of candidate.effects) {
      if (
        !isSemanticToken(effect) ||
        looksSensitive(effect) ||
        seenEffects.has(effect)
      ) {
        return invalidDefinition();
      }
      seenEffects.add(effect);
      effects.push(effect);
    }
  }

  return Object.freeze({
    category: candidate.category as SemanticJourneyCategory,
    attributes: Object.freeze(attributes),
    targets: Object.freeze(targets),
    effects: Object.freeze(effects),
  });
}

function defineSemanticJourneyCatalogUnsafe(
  definitions: Readonly<Record<string, SemanticJourneyEventDefinition>>,
  options: SemanticJourneyCatalogOptions
): SemanticJourneyCatalog {
  if (!isRecord(definitions) || !isRecord(options)) {
    return invalidDefinition();
  }

  const optionKeys = getOwnStringKeys(options);
  if (
    optionKeys === null ||
    optionKeys.length !== 1 ||
    !hasOnlyFields(optionKeys, CATALOG_OPTIONS_FIELDS) ||
    !Array.isArray(options.sources) ||
    options.sources.length === 0 ||
    options.sources.length > MAX_CATALOG_SOURCES
  ) {
    return invalidDefinition();
  }
  const sources: string[] = [];
  const seenSources = new Set<string>();
  for (const source of options.sources) {
    if (!isSemanticSource(source) || looksSensitive(source) || seenSources.has(source)) {
      return invalidDefinition();
    }
    seenSources.add(source);
    sources.push(source);
  }

  const names = getOwnStringKeys(definitions);
  if (names === null || names.length > MAX_CATALOG_EVENTS) {
    return invalidDefinition();
  }

  const normalized: Record<string, Readonly<SemanticJourneyEventDefinition>> =
    Object.create(null) as Record<
      string,
      Readonly<SemanticJourneyEventDefinition>
    >;

  for (const name of names) {
    if (!isSemanticToken(name)) {
      return invalidDefinition();
    }
    normalized[name] = normalizeEventDefinition(definitions[name]);
  }

  return Object.freeze({
    sources: Object.freeze(sources),
    definitions: Object.freeze(normalized),
  });
}

/** Creates an immutable semantic catalogue after validating every definition. */
export function defineSemanticJourneyCatalog(
  definitions: Readonly<Record<string, SemanticJourneyEventDefinition>>,
  options: SemanticJourneyCatalogOptions
): SemanticJourneyCatalog {
  try {
    return defineSemanticJourneyCatalogUnsafe(definitions, options);
  } catch {
    return invalidDefinition();
  }
}

/** Creates a one-event immutable catalogue. */
export function defineJourneyEvent(
  name: string,
  definition: SemanticJourneyEventDefinition,
  options: SemanticJourneyCatalogOptions
): SemanticJourneyCatalog {
  return defineSemanticJourneyCatalog({ [name]: definition }, options);
}

/** Looks up a registered event definition without accepting invalid tokens. */
export function getJourneyEventDefinition(
  catalogue: SemanticJourneyCatalog,
  name: unknown
): Readonly<SemanticJourneyEventDefinition> | undefined {
  if (!isSemanticToken(name)) {
    return undefined;
  }

  return Object.prototype.hasOwnProperty.call(catalogue.definitions, name)
    ? catalogue.definitions[name]
    : undefined;
}

function validateTarget(
  candidate: unknown,
  definition: Readonly<SemanticJourneyEventDefinition>
): SemanticJourneyTarget {
  if (!isRecord(candidate)) {
    return invalidInput();
  }

  const keys = getOwnStringKeys(candidate);
  if (
    keys === null ||
    keys.length !== 2 ||
    !hasOnlyFields(keys, TARGET_FIELDS) ||
    !isSemanticToken(candidate.type) ||
    !isSemanticToken(candidate.id) ||
    looksSensitive(candidate.type) ||
    looksSensitive(candidate.id)
  ) {
    return invalidInput();
  }

  const allowedTarget = (definition.targets ?? []).some(
    (target) => target.type === candidate.type && target.id === candidate.id
  );
  const allowedEffect =
    candidate.type === "effect" &&
    (definition.effects ?? []).includes(candidate.id);
  if (!allowedTarget && !allowedEffect) {
    return invalidInput();
  }

  return Object.freeze({ type: candidate.type, id: candidate.id });
}

function validateAttributeValue(
  definition: Readonly<SemanticJourneyAttributeDefinition>,
  candidate: unknown
): SemanticJourneyAttributeValue {
  if (definition.type === "boolean") {
    return typeof candidate === "boolean" ? candidate : invalidInput();
  }

  if (definition.type === "enum") {
    return typeof candidate === "string" && definition.values.includes(candidate)
      ? candidate
      : invalidInput();
  }

  if (
    typeof candidate !== "number" ||
    !Number.isFinite(candidate) ||
    candidate < definition.min ||
    candidate > definition.max ||
    (definition.integer === true && !Number.isSafeInteger(candidate))
  ) {
    return invalidInput();
  }

  return candidate;
}

/**
 * Validates and normalizes event input using a fail-closed catalogue policy.
 * Unknown fields and attributes reject the whole input; errors never echo input.
 */
function validateSemanticJourneyEventInputUnsafe(
  catalogue: SemanticJourneyCatalog,
  input: SemanticJourneyEventInput
): ValidatedSemanticJourneyEventInput {
  if (!isRecord(input)) {
    return invalidInput();
  }

  const keys = getOwnStringKeys(input);
  if (keys === null || !hasOnlyFields(keys, EVENT_INPUT_FIELDS)) {
    return invalidInput();
  }

  const definition = getJourneyEventDefinition(catalogue, input.name);
  if (
    definition === undefined ||
    input.category !== definition.category ||
    !PHASES.has(input.phase) ||
    !OUTCOMES.has(input.outcome) ||
    (input.modality !== undefined && !MODALITIES.has(input.modality))
  ) {
    return invalidInput();
  }

  const target =
    input.target === undefined
      ? undefined
      : validateTarget(input.target, definition);
  const candidateAttributes = input.attributes ?? {};
  if (!isRecord(candidateAttributes)) {
    return invalidInput();
  }

  const attributeNames = getOwnStringKeys(candidateAttributes);
  if (
    attributeNames === null ||
    attributeNames.length > MAX_EVENT_ATTRIBUTES
  ) {
    return invalidInput();
  }

  const registeredAttributes = definition.attributes ?? {};
  for (const attributeName of attributeNames) {
    if (!Object.prototype.hasOwnProperty.call(registeredAttributes, attributeName)) {
      return invalidInput();
    }
  }

  const attributes: Record<string, SemanticJourneyAttributeValue> =
    Object.create(null) as Record<string, SemanticJourneyAttributeValue>;
  for (const attributeName of attributeNames) {
    const attributeDefinition = registeredAttributes[attributeName];
    if (attributeDefinition === undefined) {
      return invalidInput();
    }
    attributes[attributeName] = validateAttributeValue(
      attributeDefinition,
      candidateAttributes[attributeName]
    );
  }

  return Object.freeze({
    name: input.name,
    category: input.category,
    phase: input.phase,
    outcome: input.outcome,
    ...(input.modality === undefined ? {} : { modality: input.modality }),
    ...(target === undefined ? {} : { target }),
    attributes: Object.freeze(attributes),
    droppedAttributeCount: 0 as const,
  });
}

/**
 * Validates and normalizes event input using a fail-closed catalogue policy.
 * Unknown fields and attributes reject the whole input; errors never echo input.
 */
export function validateSemanticJourneyEventInput(
  catalogue: SemanticJourneyCatalog,
  input: SemanticJourneyEventInput
): ValidatedSemanticJourneyEventInput {
  try {
    return validateSemanticJourneyEventInputUnsafe(catalogue, input);
  } catch (error) {
    if (error instanceof SemanticJourneyValidationError) {
      throw error;
    }
    return invalidInput();
  }
}

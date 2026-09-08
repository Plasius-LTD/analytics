import {
  defineSemanticJourneyCatalog,
  getJourneyEventDefinition,
  validateSemanticJourneyEventInput,
} from "./catalog.js";
import { isEventId } from "./context.js";
import type { SemanticJourneyAggregateBatch, SemanticJourneyAggregateCounter } from "./aggregate.js";
import type { SemanticJourneyCatalog, SemanticJourneyEventInput } from "./types.js";

/** Opt-in aggregate wire version with explicitly registered finite views. */
export const SEMANTIC_JOURNEY_PROJECTED_AGGREGATE_SCHEMA_VERSION = "2.1-aggregate" as const;
/** Maximum accepted aggregate request size; hosts must also bound body reads. */
export const SEMANTIC_JOURNEY_AGGREGATE_MAX_BYTES = 64 * 1024;

/** A reviewed application producer, never a runtime-constructed identity. */
export interface SemanticJourneyAggregateBinding {
  readonly source: string;
  readonly channel: "frontend" | "backend";
  readonly runtime: "browser" | "server";
}

/** Per-event independent views listing only existing finite enum attributes. */
export interface SemanticJourneyAggregatePolicyOptions {
  readonly bindings: readonly SemanticJourneyAggregateBinding[];
  readonly projections?: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;
}

/** Validated, immutable contract shared by producers and the receiving service. */
export interface SemanticJourneyAggregatePolicy {
  readonly catalogue: SemanticJourneyCatalog;
  readonly bindings: readonly SemanticJourneyAggregateBinding[];
  readonly projections: NonNullable<SemanticJourneyAggregatePolicyOptions["projections"]>;
}

/** One independent view count; totals must never be summed across views. */
export interface SemanticJourneyProjectedAggregateCounter extends SemanticJourneyAggregateCounter {
  readonly view: string;
  readonly dimensions: Readonly<Record<string, string>>;
}

/** An aggregate packet with no event-level evidence or private causal IDs. */
export interface SemanticJourneyProjectedAggregateBatch extends Omit<SemanticJourneyAggregateBatch, "schemaVersion" | "counters"> {
  readonly schemaVersion: typeof SEMANTIC_JOURNEY_PROJECTED_AGGREGATE_SCHEMA_VERSION;
  readonly counters: readonly SemanticJourneyProjectedAggregateCounter[];
}

/** The two strict supported wire shapes; unrestricted legacy events are absent. */
export type SemanticJourneyWireAggregateBatch = SemanticJourneyAggregateBatch | SemanticJourneyProjectedAggregateBatch;

const policies = new WeakSet<object>();
const outcomes = new Set(["unknown", "success", "failure", "cancelled", "denied"]);
const envelopeFields = ["schemaVersion", "batchId", "source", "channel", "runtime", "timeBucket", "policyVersion", "dropped", "coalesced", "counters"];
const counterFields = ["eventName", "outcome", "count"];
const projectedFields = [...counterFields, "view", "dimensions"];
const encoder = new TextEncoder();

function invalidPolicy(): never { throw new Error("Semantic aggregate policy is invalid."); }
function invalidInput(): never { throw new Error("Semantic aggregate input is invalid."); }

/** Reject accessors/symbols/custom prototypes before reading any property. */
function record(value: unknown, maxKeys = 32): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length <= maxKeys && keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return typeof key === "string" && descriptor?.enumerable && "value" in descriptor;
  });
}

function array(value: unknown, maximum: number): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) return false;
  if (Reflect.ownKeys(value).length !== value.length + 1) return false;
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return false;
  }
  return true;
}

function exact(value: Record<string, unknown>, fields: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === fields.length && keys.every((key) => fields.includes(key));
}

function count(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function bindingKey(binding: SemanticJourneyAggregateBinding): string {
  return `${binding.source}\0${binding.channel}\0${binding.runtime}`;
}

/** Checks provenance, not just structural resemblance to a reviewed policy. */
export function isSemanticJourneyAggregatePolicy(value: unknown): value is SemanticJourneyAggregatePolicy {
  return typeof value === "object" && value !== null && policies.has(value);
}

/** Compile immutable views and producer bindings from a strict event catalogue. */
export function defineSemanticJourneyAggregatePolicy(
  catalogue: SemanticJourneyCatalog,
  options: SemanticJourneyAggregatePolicyOptions,
): SemanticJourneyAggregatePolicy {
  try {
    if (!record(options) || Object.keys(options).some((key) => !["bindings", "projections"].includes(key))
      || !array(options.bindings, 128) || options.bindings.length === 0) return invalidPolicy();
    const frozenCatalogue = defineSemanticJourneyCatalog(catalogue.definitions, { sources: catalogue.sources });
    const bindings: SemanticJourneyAggregateBinding[] = [];
    const seenBindings = new Set<string>();
    for (const candidate of options.bindings) {
      if (!record(candidate) || !exact(candidate, ["source", "channel", "runtime"])
        || typeof candidate.source !== "string" || !frozenCatalogue.sources.includes(candidate.source)
        || !((candidate.channel === "frontend" && candidate.runtime === "browser")
          || (candidate.channel === "backend" && candidate.runtime === "server"))) return invalidPolicy();
      const binding = candidate as unknown as SemanticJourneyAggregateBinding;
      const key = bindingKey(binding);
      if (seenBindings.has(key)) return invalidPolicy();
      seenBindings.add(key);
      bindings.push(Object.freeze({ ...binding }));
    }
    const projections: Record<string, Readonly<Record<string, readonly string[]>>> = Object.create(null);
    const candidates = options.projections ?? {};
    if (!record(candidates, 2048)) return invalidPolicy();
    for (const [eventName, views] of Object.entries(candidates)) {
      const definition = getJourneyEventDefinition(frozenCatalogue, eventName);
      if (!definition || !record(views, 8) || Object.keys(views).length === 0) return invalidPolicy();
      const normalized: Record<string, readonly string[]> = Object.create(null);
      for (const [view, dimensions] of Object.entries(views)) {
        if (view === "total" || !array(dimensions, 4) || dimensions.length === 0
          || new Set(dimensions).size !== dimensions.length) return invalidPolicy();
        // Reuse the strict catalogue's sensitive-key/token policy, not a second regex.
        defineSemanticJourneyCatalog({ "aggregate.view": {
          category: "state", attributes: { [view]: { type: "enum", values: ["registered"] } },
        } }, { sources: frozenCatalogue.sources });
        let cardinality = 1;
        const names: string[] = [];
        for (const dimension of dimensions) {
          const attribute = typeof dimension === "string" ? definition.attributes?.[dimension] : undefined;
          if (!attribute || attribute.type !== "enum") return invalidPolicy();
          cardinality *= attribute.values.length;
          if (cardinality > 4096) return invalidPolicy();
          names.push(dimension as string);
        }
        normalized[view] = Object.freeze(names.sort());
      }
      projections[eventName] = Object.freeze(normalized);
    }
    const policy = Object.freeze({ catalogue: frozenCatalogue, bindings: Object.freeze(bindings), projections: Object.freeze(projections) });
    policies.add(policy);
    return policy;
  } catch { return invalidPolicy(); }
}

/** Project only reviewed enums, never context, target, numeric values or IDs. */
export function projectSemanticJourneyAggregateCounters(
  policy: SemanticJourneyAggregatePolicy,
  input: SemanticJourneyEventInput,
  increment = 1,
): readonly SemanticJourneyProjectedAggregateCounter[] {
  try {
    if (!isSemanticJourneyAggregatePolicy(policy) || !count(increment, 1)) return invalidInput();
    const event = validateSemanticJourneyEventInput(policy.catalogue, input);
    const base = { eventName: event.name, outcome: event.outcome, count: increment };
    const rows: SemanticJourneyProjectedAggregateCounter[] = [Object.freeze({ ...base, view: "total", dimensions: Object.freeze({}) })];
    for (const view of Object.keys(policy.projections[event.name] ?? {}).sort()) {
      const dimensions: Record<string, string> = Object.create(null);
      const names = policy.projections[event.name]![view]!;
      if (names.some((name) => event.attributes[name] === undefined)) continue;
      for (const name of names) dimensions[name] = event.attributes[name] as string;
      rows.push(Object.freeze({ ...base, view, dimensions: Object.freeze(dimensions) }));
    }
    return Object.freeze(rows);
  } catch { return invalidInput(); }
}

/** Stable view key, usable only after strict validation or projection. */
export function semanticJourneyAggregateCounterKey(counter: SemanticJourneyAggregateCounter | SemanticJourneyProjectedAggregateCounter): string {
  if (!("view" in counter)) return JSON.stringify([counter.eventName, counter.outcome]);
  return JSON.stringify([counter.eventName, counter.outcome, counter.view,
    Object.keys(counter.dimensions).sort().map((key) => [key, counter.dimensions[key]])]);
}

function validCounter(policy: SemanticJourneyAggregatePolicy, value: unknown, projected: boolean): value is SemanticJourneyAggregateCounter | SemanticJourneyProjectedAggregateCounter {
  if (!record(value) || !exact(value, projected ? projectedFields : counterFields)
    || typeof value.eventName !== "string" || typeof value.outcome !== "string"
    || !outcomes.has(value.outcome) || !count(value.count, 1)) return false;
  const definition = getJourneyEventDefinition(policy.catalogue, value.eventName);
  if (!definition) return false;
  if (!projected) return true;
  if (typeof value.view !== "string" || !record(value.dimensions, 4)) return false;
  const dimensions = value.view === "total" ? [] : policy.projections[value.eventName]?.[value.view];
  if (!dimensions || !exact(value.dimensions, dimensions)) return false;
  for (const dimension of dimensions) {
    const attribute = definition.attributes?.[dimension];
    const supplied = value.dimensions[dimension];
    if (attribute?.type !== "enum" || typeof supplied !== "string" || !attribute.values.includes(supplied)) return false;
  }
  return true;
}

/** Generate a fail-closed wire validator from the producer's reviewed policy. */
export function createSemanticJourneyAggregateValidator(policy: SemanticJourneyAggregatePolicy): (value: unknown) => value is SemanticJourneyWireAggregateBatch {
  if (!isSemanticJourneyAggregatePolicy(policy)) return invalidPolicy();
  const bindings = new Set(policy.bindings.map(bindingKey));
  return (value: unknown): value is SemanticJourneyWireAggregateBatch => {
    try {
      if (!record(value) || !exact(value, envelopeFields)
        || !["2.0-aggregate", "2.1-aggregate"].includes(value.schemaVersion as string)
        || !isEventId(value.batchId) || value.policyVersion !== "strict.v1"
        || typeof value.source !== "string" || value.source.length > 64
        || !["frontend", "backend"].includes(value.channel as string)
        || !["browser", "server"].includes(value.runtime as string)
        || !bindings.has(bindingKey(value as unknown as SemanticJourneyAggregateBinding))
        || typeof value.timeBucket !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/.test(value.timeBucket)
        || new Date(value.timeBucket).toISOString() !== value.timeBucket
        || !count(value.dropped) || !count(value.coalesced) || !array(value.counters, 500)) return false;
      const keys = new Set<string>();
      for (const counter of value.counters) {
        if (!validCounter(policy, counter, value.schemaVersion === "2.1-aggregate")) return false;
        const key = semanticJourneyAggregateCounterKey(counter);
        if (keys.has(key)) return false;
        keys.add(key);
      }
      return encoder.encode(JSON.stringify(value)).byteLength <= SEMANTIC_JOURNEY_AGGREGATE_MAX_BYTES;
    } catch { return false; }
  };
}

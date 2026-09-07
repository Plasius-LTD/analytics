import type {
  SemanticJourneyCategory,
  SemanticJourneyEventDefinition,
  SemanticJourneyEventInput,
  SemanticJourneyOutcome,
} from "./types.js";

type Bucket = readonly [upperExclusive: number, token: string];
interface MetricDefinition {
  readonly category: SemanticJourneyCategory;
  readonly outcome: SemanticJourneyOutcome;
  readonly buckets?: readonly Bucket[];
  readonly maximum?: number;
}

const durationBuckets: readonly Bucket[] = [
  [100, "lt100ms"], [250, "lt250ms"], [500, "lt500ms"],
  [1000, "lt1000ms"], [2500, "lt2500ms"], [5000, "lt5000ms"],
  [10000, "lt10000ms"], [Infinity, "gte10000ms"],
];
const duration = (category: SemanticJourneyCategory): MetricDefinition => ({
  category, outcome: "unknown", buckets: durationBuckets, maximum: 86_400_000,
});
// Fixed literal initialization is pure so hosts importing unrelated analytics
// APIs can drop this optional metric module from their initial bundle.
const metrics: Readonly<Record<string, MetricDefinition>> = /* @__PURE__ */ (() => ({
  "page.load": duration("presentation"),
  "route.ready": duration("presentation"),
  "world.ready": duration("presentation"),
  "request.duration": duration("request"),
  "vital.lcp": duration("presentation"),
  "vital.fcp": duration("presentation"),
  "vital.inp": duration("interaction"),
  "vital.ttfb": duration("request"),
  "vital.cls": {
    category: "presentation", outcome: "unknown", maximum: 100,
    buckets: [[0.1, "lt01"], [0.25, "lt025"], [Infinity, "gte025"]],
  },
  "episode.active-duration": {
    category: "state", outcome: "unknown", maximum: 86_400_000,
    buckets: [[10000, "lt10s"], [60000, "lt60s"], [300000, "lt300s"],
      [900000, "lt900s"], [3600000, "lt3600s"], [Infinity, "gte3600s"]],
  },
  "episode.started": { category: "state", outcome: "unknown" },
  "episode.completed": { category: "state", outcome: "unknown" },
  "request.started": { category: "request", outcome: "unknown" },
  "request.completed": { category: "request", outcome: "success" },
  "request.failed": { category: "request", outcome: "failure" },
  "request.cancelled": { category: "request", outcome: "cancelled" },
  "request.rejected": { category: "request", outcome: "denied" },
  "error.runtime": { category: "error", outcome: "failure" },
  "error.resource": { category: "error", outcome: "failure" },
  "error.render": { category: "error", outcome: "failure" },
  "error.unhandled": { category: "error", outcome: "failure" },
}))();

/**
 * Fixed useful-metric catalogue entries for host catalogue composition and
 * collector allowlists. Buckets are part of event names so they survive the
 * existing aggregate wire format, which deliberately does not carry attributes.
 * This is not a collector or sender and has no browser/network side effects.
 */
export const USEFUL_METRIC_EVENT_DEFINITIONS: Readonly<
  Record<string, Readonly<SemanticJourneyEventDefinition>>
> = /* @__PURE__ */ (() => Object.freeze(Object.fromEntries(Object.entries(metrics).flatMap(([metric, definition]) => {
  const names = definition.buckets
    ? definition.buckets.map(([, bucket]) => `metric.${metric}.${bucket}`)
    : [`metric.${metric}`];
  return names.map(name => [name, Object.freeze({ category: definition.category })]);
}))))();

/**
 * Projects one observation into a catalogue-controlled, identity-free event.
 * Accepts exactly { metric } for a counter or { metric, value } for a duration
 * in milliseconds (CLS is unitless). Rejects unknown/extra fields, accessors,
 * invalid numbers and legacy raw NFR payloads without reflecting their values.
 *
 * The host evaluates remote enablement, bounds observation frequency, tracks
 * this result with its semantic client, and owns disposal. Episode observations
 * are anonymous in-memory activity counts, never unique users or sessions.
 */
export function projectUsefulMetric(input: unknown): SemanticJourneyEventInput | null {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(input);
    if (keys.length < 1 || keys.length > 2 || keys.some(key => key !== "metric" && key !== "value")) return null;
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const metric = descriptors.metric;
    if (!metric || !("value" in metric) || typeof metric.value !== "string"
      || !Object.hasOwn(metrics, metric.value)) return null;
    const definition = metrics[metric.value]!;
    let name = `metric.${metric.value}`;
    if (definition.buckets) {
      const value = descriptors.value;
      if (keys.length !== 2 || !value || !("value" in value)
        || typeof value.value !== "number" || !Number.isFinite(value.value)
        || value.value < 0 || value.value > definition.maximum!) return null;
      const bucket = definition.buckets.find(([upper]) => value.value < upper)!;
      name += `.${bucket[1]}`;
    } else if (keys.length !== 1) {
      return null;
    }
    return Object.freeze({
      name, category: definition.category,
      phase: metric.value.endsWith(".started") ? "start" : "end",
      outcome: definition.outcome, modality: "system",
    });
  } catch {
    return null;
  }
}

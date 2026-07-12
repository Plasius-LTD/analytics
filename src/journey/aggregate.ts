import type {
  AnalyticsChannel,
  AnalyticsRuntime,
} from "../core/types.js";
import {
  getJourneyEventDefinition,
  isSemanticSource,
  isSemanticToken,
} from "./catalog.js";
import { isEventId } from "./context.js";
import type {
  SemanticJourneyCatalog,
  SemanticJourneyOutcome,
} from "./types.js";
import { SEMANTIC_JOURNEY_STRICT_POLICY_VERSION } from "./types.js";

/** Wire schema used by unlinkable semantic aggregate batches. */
export const SEMANTIC_JOURNEY_AGGREGATE_SCHEMA_VERSION = "2.0-aggregate" as const;

/** One low-cardinality event-name/outcome count. */
export interface SemanticJourneyAggregateCounter {
  readonly eventName: string;
  readonly outcome: SemanticJourneyOutcome;
  readonly count: number;
}

/** Aggregate-only payload that deliberately contains no causal identifiers. */
export interface SemanticJourneyAggregateBatch {
  readonly schemaVersion: typeof SEMANTIC_JOURNEY_AGGREGATE_SCHEMA_VERSION;
  readonly batchId: string;
  readonly source: string;
  readonly channel: AnalyticsChannel;
  readonly runtime: AnalyticsRuntime;
  readonly timeBucket: string;
  readonly policyVersion: typeof SEMANTIC_JOURNEY_STRICT_POLICY_VERSION;
  readonly dropped: number;
  readonly coalesced: number;
  readonly counters: readonly SemanticJourneyAggregateCounter[];
}

/** Current in-memory aggregate state for diagnostics and tests. */
export interface SemanticJourneyAggregateSnapshot {
  readonly dropped: number;
  readonly coalesced: number;
  readonly counters: readonly SemanticJourneyAggregateCounter[];
}

/** Immutable dimensions attached to every batch from one aggregate store. */
export interface SemanticJourneyAggregateStoreOptions {
  readonly catalogue: SemanticJourneyCatalog;
  readonly source: string;
  readonly channel: AnalyticsChannel;
  readonly runtime: AnalyticsRuntime;
}

/** Count, byte, identity, and time controls for constructing one batch. */
export interface CreateSemanticJourneyAggregateBatchOptions {
  readonly batchId: string;
  readonly nowEpochMs: number;
  readonly maxCounters: number;
  readonly maxBytes: number;
}

const textEncoder = new TextEncoder();
const OUTCOMES = new Set<SemanticJourneyOutcome>([
  "unknown",
  "success",
  "failure",
  "cancelled",
  "denied",
]);

function invalidAggregate(): never {
  throw new Error("semantic journey aggregate input is invalid");
}

function toCounterKey(eventName: string, outcome: SemanticJourneyOutcome): string {
  return `${eventName}\u0000${outcome}`;
}

function toHourBucket(epochMs: number): string {
  const date = new Date(epochMs);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("semantic journey aggregate time is invalid");
  }

  date.setUTCMinutes(0, 0, 0);
  return date.toISOString();
}

function byteLength(value: unknown): number {
  return textEncoder.encode(JSON.stringify(value)).byteLength;
}

function normalizeLimit(value: number, minimum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`semantic journey aggregate ${name} is invalid`);
  }
  return value;
}

function addSafeCount(current: number, increment: number): number {
  const next = current + increment;
  if (!Number.isSafeInteger(next)) {
    return invalidAggregate();
  }
  return next;
}

/**
 * Holds only unlinkable aggregate counters. Individual event and causal
 * identifiers are deliberately not accepted by this store.
 */
export class SemanticJourneyAggregateStore {
  private readonly counters = new Map<string, SemanticJourneyAggregateCounter>();
  private readonly options: SemanticJourneyAggregateStoreOptions;
  private dropped = 0;
  private coalesced = 0;

  public constructor(options: SemanticJourneyAggregateStoreOptions) {
    if (
      !isSemanticSource(options.source) ||
      !options.catalogue.sources.includes(options.source) ||
      (options.channel !== "frontend" && options.channel !== "backend") ||
      (options.runtime !== "browser" && options.runtime !== "server")
    ) {
      invalidAggregate();
    }
    this.options = Object.freeze({ ...options });
  }

  public record(eventName: string, outcome: SemanticJourneyOutcome, count = 1): void {
    if (
      !isSemanticToken(eventName) ||
      getJourneyEventDefinition(this.options.catalogue, eventName) === undefined ||
      !OUTCOMES.has(outcome)
    ) {
      invalidAggregate();
    }
    normalizeLimit(count, 1, "counter increment");
    const key = toCounterKey(eventName, outcome);
    const existing = this.counters.get(key);
    this.counters.set(key, Object.freeze({
      eventName,
      outcome,
      count: addSafeCount(existing?.count ?? 0, count),
    }));
  }

  public recordDropped(count = 1): void {
    this.dropped = addSafeCount(
      this.dropped,
      normalizeLimit(count, 1, "dropped increment")
    );
  }

  public recordCoalesced(count = 1): void {
    this.coalesced = addSafeCount(
      this.coalesced,
      normalizeLimit(count, 1, "coalesced increment")
    );
  }

  public snapshot(): SemanticJourneyAggregateSnapshot {
    return Object.freeze({
      dropped: this.dropped,
      coalesced: this.coalesced,
      counters: this.sortedCounters(),
    });
  }

  public createBatch(
    options: CreateSemanticJourneyAggregateBatchOptions,
  ): SemanticJourneyAggregateBatch | null {
    if (!isEventId(options.batchId)) {
      invalidAggregate();
    }
    const maxCounters = normalizeLimit(options.maxCounters, 1, "counter limit");
    const maxBytes = normalizeLimit(options.maxBytes, 512, "byte limit");
    const availableCounters = this.sortedCounters();
    if (
      availableCounters.length === 0
      && this.dropped === 0
      && this.coalesced === 0
    ) {
      return null;
    }

    const selected: SemanticJourneyAggregateCounter[] = [];
    const base = {
      schemaVersion: SEMANTIC_JOURNEY_AGGREGATE_SCHEMA_VERSION,
      batchId: options.batchId,
      source: this.options.source,
      channel: this.options.channel,
      runtime: this.options.runtime,
      timeBucket: toHourBucket(options.nowEpochMs),
      policyVersion: SEMANTIC_JOURNEY_STRICT_POLICY_VERSION,
      dropped: this.dropped,
      coalesced: this.coalesced,
    } as const;

    for (const counter of availableCounters) {
      if (selected.length >= maxCounters) {
        break;
      }

      const candidate = { ...base, counters: [...selected, counter] };
      if (byteLength(candidate) > maxBytes) {
        break;
      }
      selected.push(counter);
    }

    const batch: SemanticJourneyAggregateBatch = Object.freeze({
      ...base,
      counters: Object.freeze([...selected]),
    });
    if (byteLength(batch) > maxBytes) {
      throw new Error("semantic journey aggregate batch limit is too small");
    }
    if (availableCounters.length > 0 && selected.length === 0) {
      throw new Error("semantic journey aggregate counter exceeds batch limit");
    }

    return batch;
  }

  public acknowledge(batch: SemanticJourneyAggregateBatch): void {
    for (const acknowledged of batch.counters) {
      const key = toCounterKey(acknowledged.eventName, acknowledged.outcome);
      const current = this.counters.get(key);
      if (!current) {
        continue;
      }

      const remaining = current.count - acknowledged.count;
      if (remaining > 0) {
        this.counters.set(key, Object.freeze({ ...current, count: remaining }));
      } else {
        this.counters.delete(key);
      }
    }

    this.dropped = Math.max(0, this.dropped - batch.dropped);
    this.coalesced = Math.max(0, this.coalesced - batch.coalesced);
  }

  public clear(): void {
    this.counters.clear();
    this.dropped = 0;
    this.coalesced = 0;
  }

  private sortedCounters(): readonly SemanticJourneyAggregateCounter[] {
    return Object.freeze(Array.from(this.counters.values()).sort((left, right) => {
      const byName = left.eventName.localeCompare(right.eventName);
      return byName !== 0 ? byName : left.outcome.localeCompare(right.outcome);
    }));
  }
}

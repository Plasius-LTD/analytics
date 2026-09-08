import type { CreateSemanticJourneyAggregateBatchOptions } from "./aggregate.js";
import {
  isSemanticJourneyAggregatePolicy,
  projectSemanticJourneyAggregateCounters,
  semanticJourneyAggregateCounterKey,
  type SemanticJourneyAggregateBinding,
  type SemanticJourneyAggregatePolicy,
  type SemanticJourneyProjectedAggregateBatch,
  type SemanticJourneyProjectedAggregateCounter,
} from "./aggregate-policy.js";
import { isEventId } from "./context.js";
import type { SemanticJourneyEventInput } from "./types.js";

/** Host-owned limits for pending aggregate rows, independent of local stories. */
export interface ProjectedSemanticJourneyAggregateStoreOptions extends SemanticJourneyAggregateBinding {
  readonly policy: SemanticJourneyAggregatePolicy;
  readonly maxPendingCounters?: number;
  readonly maxPendingBytes?: number;
  readonly maxAgeMs?: number;
  readonly now?: () => number;
}

interface PendingCounter {
  readonly timeBucket: string;
  readonly expiresAt: number;
  readonly counter: SemanticJourneyProjectedAggregateCounter;
  readonly bytes: number;
}

const encoder = new TextEncoder();
function invalid(): never { throw new Error("Semantic aggregate input is invalid."); }
function bytes(value: unknown): number { return encoder.encode(JSON.stringify(value)).length; }
function limit(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) return invalid();
  return selected;
}
function hour(now: number): string {
  if (!Number.isSafeInteger(now) || now < 0 || now > 253_402_300_799_999) return invalid();
  return new Date(Math.floor(now / 3_600_000) * 3_600_000).toISOString();
}
function add(left: number, right: number): number {
  if (!Number.isSafeInteger(right) || right < 1 || !Number.isSafeInteger(left + right)) return invalid();
  return left + right;
}
function key(timeBucket: string, counter: SemanticJourneyProjectedAggregateCounter): string {
  return `${timeBucket}\0${semanticJourneyAggregateCounterKey(counter)}`;
}

/**
 * Holds a bounded set of independent aggregate views by original observation
 * hour. One immutable retry snapshot is retained; no event IDs enter this store.
 */
export class ProjectedSemanticJourneyAggregateStore {
  private readonly options: ProjectedSemanticJourneyAggregateStoreOptions;
  private readonly maxCounters: number;
  private readonly maxBytes: number;
  private readonly maxAge: number;
  private readonly counters = new Map<string, PendingCounter>();
  private pendingBytes = 0;
  private dropped = 0;
  private coalesced = 0;
  private diagnosticHour: string | undefined;
  private diagnosticExpiry = 0;
  private pending: { batch: SemanticJourneyProjectedAggregateBatch; expiresAt: number } | undefined;

  public constructor(options: ProjectedSemanticJourneyAggregateStoreOptions) {
    if (!isSemanticJourneyAggregatePolicy(options.policy) || !options.policy.bindings.some((binding) =>
      binding.source === options.source && binding.channel === options.channel && binding.runtime === options.runtime)) invalid();
    this.maxCounters = limit(options.maxPendingCounters, 1000, 1, 5000);
    this.maxBytes = limit(options.maxPendingBytes, 1024 * 1024, 512, 8 * 1024 * 1024);
    this.maxAge = limit(options.maxAgeMs, 30 * 60 * 1000, 1, 86_400_000);
    if (options.now !== undefined && typeof options.now !== "function") invalid();
    this.options = Object.freeze({ ...options });
  }

  /** Return false on capacity pressure; never retain a partial set of views. */
  public recordEvent(input: SemanticJourneyEventInput, observedAt: number, increment = 1): boolean {
    const timeBucket = hour(observedAt);
    const rows = projectSemanticJourneyAggregateCounters(this.options.policy, input, increment);
    this.prune(observedAt);
    const updates: [string, PendingCounter][] = [];
    let size = this.pendingBytes;
    let additions = 0;
    for (const row of rows) {
      const id = key(timeBucket, row);
      const existing = this.counters.get(id);
      const counter = Object.freeze({ ...row, count: add(existing?.counter.count ?? 0, increment) });
      const entry = {
        timeBucket,
        expiresAt: Math.min(existing?.expiresAt ?? Infinity, observedAt + this.maxAge),
        counter,
        // Conservative accounting includes duplicated key text and map bookkeeping.
        bytes: bytes(counter) + encoder.encode(id).length + 64,
      };
      size += entry.bytes - (existing?.bytes ?? 0);
      if (!existing) additions++;
      updates.push([id, entry]);
    }
    if (this.counters.size + additions > this.maxCounters || size > this.maxBytes) {
      this.diagnostic("dropped", increment, observedAt);
      return false;
    }
    for (const [id, entry] of updates) this.counters.set(id, entry);
    this.pendingBytes = size;
    return true;
  }

  public recordDropped(increment = 1): void { this.diagnostic("dropped", increment, this.now()); }
  public recordCoalesced(increment = 1): void { this.diagnostic("coalesced", increment, this.now()); }

  /** Read-only bounded diagnostics; never a persistence interface. */
  public snapshot() {
    return Object.freeze({ dropped: this.dropped, coalesced: this.coalesced,
      pendingCounters: this.counters.size, pendingBytes: this.pendingBytes,
      counters: Object.freeze(this.sorted().map((entry) => entry.counter)) });
  }

  public createBatch(options: CreateSemanticJourneyAggregateBatchOptions): SemanticJourneyProjectedAggregateBatch | null {
    hour(options.nowEpochMs);
    if (!isEventId(options.batchId)) return invalid();
    const maxCounters = limit(options.maxCounters, 50, 1, 500);
    const maxBytes = limit(options.maxBytes, 48 * 1024, 512, 60 * 1024);
    this.prune(options.nowEpochMs);
    if (this.pending) return this.pending.batch;
    const entries = this.sorted();
    const earliest = entries[0]?.timeBucket;
    const timeBucket = earliest && this.diagnosticHour
      ? (earliest < this.diagnosticHour ? earliest : this.diagnosticHour) : earliest ?? this.diagnosticHour;
    if (!timeBucket) return null;
    const includeDiagnostics = timeBucket === this.diagnosticHour;
    const base = {
      schemaVersion: "2.1-aggregate" as const, batchId: options.batchId,
      source: this.options.source, channel: this.options.channel, runtime: this.options.runtime,
      timeBucket, policyVersion: "strict.v1" as const,
      dropped: includeDiagnostics ? this.dropped : 0, coalesced: includeDiagnostics ? this.coalesced : 0,
    };
    const selected: SemanticJourneyProjectedAggregateCounter[] = [];
    let expiresAt = includeDiagnostics ? this.diagnosticExpiry : Infinity;
    for (const entry of entries) {
      if (entry.timeBucket !== timeBucket) continue;
      if (selected.length >= maxCounters || bytes({ ...base, counters: [...selected, entry.counter] }) > maxBytes) break;
      selected.push(entry.counter);
      expiresAt = Math.min(expiresAt, entry.expiresAt);
    }
    if ((entries.some((entry) => entry.timeBucket === timeBucket) && selected.length === 0)
      || bytes({ ...base, counters: selected }) > maxBytes) return invalid();
    const batch = Object.freeze({ ...base, counters: Object.freeze(selected) });
    this.pending = { batch, expiresAt };
    return batch;
  }

  /** Check retry eligibility without extending the original snapshot's expiry. */
  public isPendingBatch(batch: SemanticJourneyProjectedAggregateBatch, now: number): boolean {
    this.prune(now);
    return this.pending?.batch === batch;
  }

  /** Only the exact issued snapshot may subtract counts, and only once. */
  public acknowledge(batch: SemanticJourneyProjectedAggregateBatch): void {
    if (this.pending?.batch !== batch) return;
    for (const counter of batch.counters) {
      const id = key(batch.timeBucket, counter);
      const current = this.counters.get(id);
      if (!current) continue;
      this.pendingBytes -= current.bytes;
      const remaining = current.counter.count - counter.count;
      if (remaining <= 0) this.counters.delete(id);
      else {
        const updatedCounter = Object.freeze({ ...current.counter, count: remaining });
        const updated = { ...current, counter: updatedCounter,
          bytes: bytes(updatedCounter) + encoder.encode(id).length + 64 };
        this.counters.set(id, updated);
        this.pendingBytes += updated.bytes;
      }
    }
    this.dropped = Math.max(0, this.dropped - batch.dropped);
    this.coalesced = Math.max(0, this.coalesced - batch.coalesced);
    if (!this.dropped && !this.coalesced) this.diagnosticHour = undefined;
    this.pending = undefined;
  }

  /** Discard aggregates and in-flight snapshot ownership; never flush. */
  public clear(): void {
    this.counters.clear();
    this.pendingBytes = this.dropped = this.coalesced = this.diagnosticExpiry = 0;
    this.diagnosticHour = undefined;
    this.pending = undefined;
  }

  private now(): number { return (this.options.now ?? Date.now)(); }

  private diagnostic(kind: "dropped" | "coalesced", increment: number, now: number): void {
    const timeBucket = hour(now);
    this[kind] = add(this[kind], increment);
    if (!this.diagnosticHour) {
      this.diagnosticHour = timeBucket;
      this.diagnosticExpiry = now + this.maxAge;
    }
  }

  private prune(now: number): void {
    hour(now);
    if (this.pending && now >= this.pending.expiresAt) this.pending = undefined;
    if (this.diagnosticHour && now >= this.diagnosticExpiry) {
      this.dropped = this.coalesced = 0;
      this.diagnosticHour = undefined;
    }
    // Drop the complete hour together: retaining newer view cells after their
    // total expired would create internally inconsistent reports. This may
    // conservatively discard newer observations; it never extends old expiry.
    const expiredHours = new Set([...this.counters.values()]
      .filter((entry) => now >= entry.expiresAt).map((entry) => entry.timeBucket));
    if (this.pending && expiredHours.has(this.pending.batch.timeBucket)) this.pending = undefined;
    for (const [id, entry] of this.counters) {
      if (!expiredHours.has(entry.timeBucket)) continue;
      this.counters.delete(id);
      this.pendingBytes -= entry.bytes;
      if (entry.counter.view === "total") this.diagnostic("dropped", entry.counter.count, now);
    }
  }

  private sorted(): PendingCounter[] {
    return [...this.counters.values()].sort((a, b) => {
      const left = key(a.timeBucket, a.counter); const right = key(b.timeBucket, b.counter);
      return left < right ? -1 : left > right ? 1 : 0;
    });
  }
}

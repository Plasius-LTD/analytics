import type { AnalyticsChannel, AnalyticsRuntime } from "../core/types.js";
import {
  SemanticJourneyAggregateStore,
  type SemanticJourneyAggregateBatch,
} from "./aggregate.js";
import {
  isSemanticSource,
  validateSemanticJourneyEventInput,
} from "./catalog.js";
import {
  createChildJourneyContext,
  createEventId,
  createJourneyContext,
  createProducerId,
  createRequestJourneyContext,
  createSpanId,
  formatTraceparent,
  isEventId,
  type RandomByteSource,
} from "./context.js";
import {
  parseSemanticJourneyReceipts,
  type SemanticJourneyConsequenceReceipt,
} from "./receipt.js";
import {
  reconstructSemanticJourney,
  type SemanticJourneyReplay,
} from "./replay.js";
import {
  createDefaultSemanticJourneyAggregateTransport,
  isSecureSemanticJourneyEndpoint,
  SemanticJourneyTransportError,
  type SemanticJourneyAggregateTransport,
} from "./transport.js";
import type {
  SemanticJourneyCatalog,
  SemanticJourneyContext,
  SemanticJourneyEvent,
  SemanticJourneyEventInput,
  ValidatedSemanticJourneyEventInput,
} from "./types.js";
import { SEMANTIC_JOURNEY_STRICT_POLICY_VERSION } from "./types.js";

const DEFAULT_AGGREGATE_FLUSH_INTERVAL_MS = 60_000;
const DEFAULT_AGGREGATE_MAX_COUNTERS = 50;
const DEFAULT_AGGREGATE_MAX_BYTES = 48 * 1024;
const DEFAULT_MAX_BATCHES_PER_FLUSH = 10;
const DEFAULT_MAX_QUEUE_EVENTS = 1_000;
const DEFAULT_MAX_QUEUE_BYTES = 1024 * 1024;
const DEFAULT_MAX_EVENT_AGE_MS = 30 * 60 * 1000;
const DEFAULT_EPISODE_IDLE_MS = 30 * 60 * 1000;
const DEFAULT_COALESCE_WINDOW_MS = 1_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 250;
const DEFAULT_RETRY_MAX_DELAY_MS = 30_000;
const MIN_AGGREGATE_BYTES = 512;
const MIN_QUEUE_BYTES = 512;
const MAX_AGGREGATE_FLUSH_INTERVAL_MS = 10 * 60 * 1000;
const MAX_AGGREGATE_COUNTERS = 500;
const MAX_AGGREGATE_BYTES = 60 * 1024;
const MAX_BATCHES_PER_FLUSH = 20;
const MAX_QUEUE_EVENTS = 5_000;
const MAX_QUEUE_BYTES = 8 * 1024 * 1024;
const MAX_EVENT_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_EPISODE_IDLE_MS = 2 * 60 * 60 * 1000;
const MAX_COALESCE_WINDOW_MS = 60_000;
const MAX_REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 5;
const MAX_RETRY_BASE_DELAY_MS = 30_000;
const MAX_RETRY_DELAY_MS = 5 * 60 * 1000;
const CONTENT_TYPE = "application/json";

/** Stable reasons for locally discarded semantic evidence. */
export type SemanticJourneyDropReason =
  | "invalid"
  | "queue-limit"
  | "expired"
  | "transport-rejected";

/** Injectable cancellable delay used by bounded retry logic. */
export type SemanticJourneyRetryDelay = (
  delayMs: number,
  signal: AbortSignal
) => Promise<void>;

/** Optional causal link supplied when recording an event. */
export interface SemanticJourneyTrackOptions {
  readonly causedByEventId?: string;
}

/** A safe outbound request link whose private journey ID is never serialized. */
export interface SemanticJourneyRequestLink {
  readonly requestEvent: SemanticJourneyEvent;
  readonly traceparent: string;
  complete(
    consequenceReceiptHeader: string | null | undefined
  ): readonly SemanticJourneyEvent[];
}

/** Configuration for a local-private semantic journey producer. */
export interface SemanticJourneyClientConfig {
  readonly catalogue: SemanticJourneyCatalog;
  readonly source: string;
  readonly channel?: AnalyticsChannel;
  readonly runtime?: AnalyticsRuntime;
  readonly enabled?: boolean;
  readonly aggregateEndpoint?: string;
  readonly aggregateBaseUrl?: string;
  readonly aggregateTransport?: SemanticJourneyAggregateTransport;
  readonly autoFlush?: boolean;
  readonly aggregateFlushIntervalMs?: number;
  readonly aggregateMaxCounters?: number;
  readonly aggregateMaxBytes?: number;
  readonly maxBatchesPerFlush?: number;
  readonly maxQueueEvents?: number;
  readonly maxQueueBytes?: number;
  readonly maxEventAgeMs?: number;
  readonly episodeIdleMs?: number;
  readonly coalesceWindowMs?: number;
  readonly requestTimeoutMs?: number;
  readonly maxRetries?: number;
  readonly retryBaseDelayMs?: number;
  readonly retryMaxDelayMs?: number;
  readonly randomBytes?: RandomByteSource;
  readonly now?: () => number;
  readonly retryDelay?: SemanticJourneyRetryDelay;
  readonly onDrop?: (reason: SemanticJourneyDropReason) => void;
}

/** Public operations exposed by a local-private semantic journey producer. */
export interface SemanticJourneyClient {
  readonly source: string;
  readonly channel: AnalyticsChannel;
  readonly runtime: AnalyticsRuntime;
  track(
    input: SemanticJourneyEventInput,
    options?: SemanticJourneyTrackOptions
  ): SemanticJourneyEvent | undefined;
  beginRequest(
    input: SemanticJourneyEventInput,
    options?: SemanticJourneyTrackOptions
  ): SemanticJourneyRequestLink | undefined;
  getEvents(): readonly SemanticJourneyEvent[];
  reconstruct(): SemanticJourneyReplay;
  flush(): Promise<void>;
  rotate(): void;
  clear(): void;
  destroy(): void;
}

interface ResolvedSemanticJourneyClientConfig {
  readonly catalogue: SemanticJourneyCatalog;
  readonly source: string;
  readonly channel: AnalyticsChannel;
  readonly runtime: AnalyticsRuntime;
  readonly enabled: boolean;
  readonly aggregateEndpoint?: string;
  readonly aggregateTransport: SemanticJourneyAggregateTransport;
  readonly autoFlush: boolean;
  readonly aggregateFlushIntervalMs: number;
  readonly aggregateMaxCounters: number;
  readonly aggregateMaxBytes: number;
  readonly maxBatchesPerFlush: number;
  readonly maxQueueEvents: number;
  readonly maxQueueBytes: number;
  readonly maxEventAgeMs: number;
  readonly episodeIdleMs: number;
  readonly coalesceWindowMs: number;
  readonly requestTimeoutMs: number;
  readonly maxRetries: number;
  readonly retryBaseDelayMs: number;
  readonly retryMaxDelayMs: number;
  readonly randomBytes?: RandomByteSource;
  readonly now: () => number;
  readonly retryDelay: SemanticJourneyRetryDelay;
  readonly onDrop?: (reason: SemanticJourneyDropReason) => void;
}

interface LocalEpisode {
  readonly root: SemanticJourneyContext;
  readonly producerId: string;
  producerSequence: number;
  lastActivityEpochMs: number;
}

interface QueuedEvent {
  readonly event: SemanticJourneyEvent;
  readonly context: SemanticJourneyContext;
  readonly bytes: number;
}

interface AppendEventOptions {
  readonly context: SemanticJourneyContext;
  readonly causedByEventId?: string;
  readonly source?: string;
  readonly channel?: AnalyticsChannel;
  readonly runtime?: AnalyticsRuntime;
  readonly producerId?: string;
  readonly producerSequence?: number;
}

const textEncoder = new TextEncoder();

function invalidConfig(): never {
  throw new Error("Semantic journey client configuration is invalid.");
}

function resolveInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const resolved = value ?? fallback;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < minimum ||
    resolved > maximum
  ) {
    return invalidConfig();
  }
  return resolved;
}

function resolveRuntime(runtime: AnalyticsRuntime | undefined): AnalyticsRuntime {
  if (runtime) {
    return runtime;
  }
  return typeof window === "undefined" ? "server" : "browser";
}

function resolveChannel(
  channel: AnalyticsChannel | undefined,
  runtime: AnalyticsRuntime
): AnalyticsChannel {
  return channel ?? (runtime === "server" ? "backend" : "frontend");
}

function defaultRetryDelay(
  delayMs: number,
  signal: AbortSignal
): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(new SemanticJourneyTransportError("aborted", true));
  }

  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = (): void => {
      globalThis.clearTimeout(timer);
      reject(new SemanticJourneyTransportError("aborted", true));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isAllowedEndpoint(endpoint: string, baseUrl?: string): boolean {
  return isSecureSemanticJourneyEndpoint(endpoint, baseUrl);
}

function resolveConfig(
  config: SemanticJourneyClientConfig
): ResolvedSemanticJourneyClientConfig {
  if (!isSemanticSource(config.source)) {
    return invalidConfig();
  }
  if (!config.catalogue.sources.includes(config.source)) {
    return invalidConfig();
  }
  if (
    config.aggregateEndpoint !== undefined &&
    !isAllowedEndpoint(config.aggregateEndpoint, config.aggregateBaseUrl)
  ) {
    return invalidConfig();
  }

  const runtime = resolveRuntime(config.runtime);
  const retryBaseDelayMs = resolveInteger(
    config.retryBaseDelayMs,
    DEFAULT_RETRY_BASE_DELAY_MS,
    1,
    MAX_RETRY_BASE_DELAY_MS
  );
  const retryMaxDelayMs = resolveInteger(
    config.retryMaxDelayMs,
    DEFAULT_RETRY_MAX_DELAY_MS,
    retryBaseDelayMs,
    MAX_RETRY_DELAY_MS
  );

  return {
    catalogue: config.catalogue,
    source: config.source,
    channel: resolveChannel(config.channel, runtime),
    runtime,
    enabled: config.enabled ?? false,
    ...(config.aggregateEndpoint
      ? { aggregateEndpoint: config.aggregateEndpoint }
      : {}),
    aggregateTransport:
      config.aggregateTransport ??
      createDefaultSemanticJourneyAggregateTransport({
        ...(config.aggregateBaseUrl ? { baseUrl: config.aggregateBaseUrl } : {}),
        ...(config.now ? { now: config.now } : {}),
      }),
    autoFlush: config.autoFlush ?? true,
    aggregateFlushIntervalMs: resolveInteger(
      config.aggregateFlushIntervalMs,
      DEFAULT_AGGREGATE_FLUSH_INTERVAL_MS,
      1_000,
      MAX_AGGREGATE_FLUSH_INTERVAL_MS
    ),
    aggregateMaxCounters: resolveInteger(
      config.aggregateMaxCounters,
      DEFAULT_AGGREGATE_MAX_COUNTERS,
      1,
      MAX_AGGREGATE_COUNTERS
    ),
    aggregateMaxBytes: resolveInteger(
      config.aggregateMaxBytes,
      DEFAULT_AGGREGATE_MAX_BYTES,
      MIN_AGGREGATE_BYTES,
      MAX_AGGREGATE_BYTES
    ),
    maxBatchesPerFlush: resolveInteger(
      config.maxBatchesPerFlush,
      DEFAULT_MAX_BATCHES_PER_FLUSH,
      1,
      MAX_BATCHES_PER_FLUSH
    ),
    maxQueueEvents: resolveInteger(
      config.maxQueueEvents,
      DEFAULT_MAX_QUEUE_EVENTS,
      1,
      MAX_QUEUE_EVENTS
    ),
    maxQueueBytes: resolveInteger(
      config.maxQueueBytes,
      DEFAULT_MAX_QUEUE_BYTES,
      MIN_QUEUE_BYTES,
      MAX_QUEUE_BYTES
    ),
    maxEventAgeMs: resolveInteger(
      config.maxEventAgeMs,
      DEFAULT_MAX_EVENT_AGE_MS,
      1,
      MAX_EVENT_AGE_MS
    ),
    episodeIdleMs: resolveInteger(
      config.episodeIdleMs,
      DEFAULT_EPISODE_IDLE_MS,
      1,
      MAX_EPISODE_IDLE_MS
    ),
    coalesceWindowMs: resolveInteger(
      config.coalesceWindowMs,
      DEFAULT_COALESCE_WINDOW_MS,
      0,
      MAX_COALESCE_WINDOW_MS
    ),
    requestTimeoutMs: resolveInteger(
      config.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
      1,
      MAX_REQUEST_TIMEOUT_MS
    ),
    maxRetries: resolveInteger(
      config.maxRetries,
      DEFAULT_MAX_RETRIES,
      0,
      MAX_RETRIES
    ),
    retryBaseDelayMs,
    retryMaxDelayMs,
    ...(config.randomBytes ? { randomBytes: config.randomBytes } : {}),
    now: config.now ?? (() => Date.now()),
    retryDelay: config.retryDelay ?? defaultRetryDelay,
    ...(config.onDrop ? { onDrop: config.onDrop } : {}),
  };
}

function copyEvent(event: SemanticJourneyEvent): SemanticJourneyEvent {
  return Object.freeze({
    ...event,
    ...(event.target
      ? { target: Object.freeze({ ...event.target }) }
      : {}),
    attributes: Object.freeze({ ...event.attributes }),
    privacy: Object.freeze({ ...event.privacy }),
  });
}

function eventBytes(event: SemanticJourneyEvent): number {
  return textEncoder.encode(JSON.stringify(event)).byteLength;
}

function sameTarget(
  left: SemanticJourneyEvent["target"],
  right: SemanticJourneyEvent["target"]
): boolean {
  return left?.type === right?.type && left?.id === right?.id;
}

function shouldCoalesce(
  previous: SemanticJourneyEvent | undefined,
  next: SemanticJourneyEvent,
  windowMs: number
): boolean {
  return Boolean(
    previous &&
      next.phase === "progress" &&
      previous.phase === "progress" &&
      previous.name === next.name &&
      previous.outcome === next.outcome &&
      sameTarget(previous.target, next.target) &&
      next.occurredAtEpochMs - previous.occurredAtEpochMs <= windowMs
  );
}

function jitteredDelay(
  attempt: number,
  config: ResolvedSemanticJourneyClientConfig
): number {
  const exponential = Math.min(
    config.retryMaxDelayMs,
    config.retryBaseDelayMs * 2 ** attempt
  );
  const bytes = config.randomBytes
    ? config.randomBytes(2)
    : globalThis.crypto.getRandomValues(new Uint8Array(2));
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 2) {
    throw new Error("Semantic journey retry random source is invalid.");
  }
  const sample = ((bytes[0] ?? 0) << 8) | (bytes[1] ?? 0);
  const factor = 0.5 + sample / 65_535;
  return Math.min(config.retryMaxDelayMs, Math.max(1, Math.round(exponential * factor)));
}

/**
 * Creates an opt-in, local-private semantic journey client.
 *
 * Individual events remain in bounded memory. `flush()` serializes only the
 * aggregate counter schema, never the local event or causal identifiers.
 */
export function createSemanticJourneyClient(
  inputConfig: SemanticJourneyClientConfig
): SemanticJourneyClient {
  let config: ResolvedSemanticJourneyClientConfig;
  try {
    config = resolveConfig(inputConfig);
  } catch {
    return invalidConfig();
  }
  const aggregateStore = new SemanticJourneyAggregateStore({
    catalogue: config.catalogue,
    source: config.source,
    channel: config.channel,
    runtime: config.runtime,
  });
  const queue: QueuedEvent[] = [];
  const contextByEventId = new Map<string, SemanticJourneyContext>();
  let episode: LocalEpisode | undefined;
  let queueBytes = 0;
  let destroyed = false;
  let aggregateGeneration = 0;
  let aggregateController = new AbortController();
  let pendingBatch: SemanticJourneyAggregateBatch | undefined;
  let flushInFlight: Promise<void> | undefined;
  let activeTransportController: AbortController | undefined;
  let interval: ReturnType<typeof globalThis.setInterval> | undefined;

  const notifyDrop = (reason: SemanticJourneyDropReason): void => {
    try {
      config.onDrop?.(reason);
    } catch {
      // Observability callbacks must never affect application behaviour.
    }
  };

  const newEpisode = (nowEpochMs: number): LocalEpisode => ({
    root: createJourneyContext(config.randomBytes),
    producerId: createProducerId(config.randomBytes),
    producerSequence: 0,
    lastActivityEpochMs: nowEpochMs,
  });

  const clearLocalQueue = (): void => {
    queue.length = 0;
    queueBytes = 0;
    contextByEventId.clear();
  };

  const rotateAt = (nowEpochMs: number): void => {
    clearLocalQueue();
    episode = newEpisode(nowEpochMs);
  };

  const removeFirstQueued = (reason: "queue-limit" | "expired"): void => {
    const removed = queue.shift();
    if (!removed) {
      return;
    }
    queueBytes -= removed.bytes;
    contextByEventId.delete(removed.event.eventId);
    aggregateStore.recordDropped();
    notifyDrop(reason);
  };

  const pruneExpired = (nowEpochMs: number): void => {
    while (
      queue[0] &&
      nowEpochMs - queue[0].event.occurredAtEpochMs > config.maxEventAgeMs
    ) {
      removeFirstQueued("expired");
    }
  };

  const ensureEpisode = (nowEpochMs: number): LocalEpisode => {
    if (!episode) {
      episode = newEpisode(nowEpochMs);
    } else if (
      nowEpochMs - episode.lastActivityEpochMs >= config.episodeIdleMs
    ) {
      rotateAt(nowEpochMs);
    }
    pruneExpired(nowEpochMs);
    episode.lastActivityEpochMs = nowEpochMs;
    return episode;
  };

  const appendValidated = (
    validated: ValidatedSemanticJourneyEventInput,
    options: AppendEventOptions,
    nowEpochMs: number
  ): SemanticJourneyEvent | undefined => {
    const currentEpisode = ensureEpisode(nowEpochMs);
    if (options.context.journeyId !== currentEpisode.root.journeyId) {
      notifyDrop("expired");
      return undefined;
    }
    const usesLocalProducer = options.producerId === undefined;
    const producerSequence = usesLocalProducer
      ? currentEpisode.producerSequence + 1
      : options.producerSequence;
    if (!Number.isSafeInteger(producerSequence) || (producerSequence ?? 0) < 1) {
      notifyDrop("invalid");
      return undefined;
    }

    const event: SemanticJourneyEvent = Object.freeze({
      schemaVersion: "2.0",
      eventId: createEventId(config.randomBytes),
      journeyId: options.context.journeyId,
      traceId: options.context.traceId,
      spanId: options.context.spanId,
      ...(options.context.parentSpanId
        ? { parentSpanId: options.context.parentSpanId }
        : {}),
      ...(options.causedByEventId
        ? { causedByEventId: options.causedByEventId }
        : {}),
      producerId: options.producerId ?? currentEpisode.producerId,
      producerSequence: producerSequence as number,
      occurredAtEpochMs: nowEpochMs,
      source: options.source ?? config.source,
      channel: options.channel ?? config.channel,
      runtime: options.runtime ?? config.runtime,
      name: validated.name,
      category: validated.category,
      phase: validated.phase,
      outcome: validated.outcome,
      ...(validated.modality ? { modality: validated.modality } : {}),
      ...(validated.target
        ? { target: Object.freeze({ ...validated.target }) }
        : {}),
      attributes: Object.freeze({ ...validated.attributes }),
      privacy: Object.freeze({
        mode: "strict",
        policyVersion: SEMANTIC_JOURNEY_STRICT_POLICY_VERSION,
        droppedAttributeCount: validated.droppedAttributeCount,
      }),
    });

    aggregateStore.record(event.name, event.outcome);
    if (
      shouldCoalesce(
        queue[queue.length - 1]?.event,
        event,
        config.coalesceWindowMs
      )
    ) {
      aggregateStore.recordCoalesced();
      return undefined;
    }

    const bytes = eventBytes(event);
    if (bytes > config.maxQueueBytes) {
      aggregateStore.recordDropped();
      notifyDrop("queue-limit");
      return undefined;
    }

    while (
      queue.length >= config.maxQueueEvents ||
      queueBytes + bytes > config.maxQueueBytes
    ) {
      removeFirstQueued("queue-limit");
    }

    queue.push({ event, context: options.context, bytes });
    queueBytes += bytes;
    contextByEventId.set(event.eventId, options.context);
    if (usesLocalProducer) {
      currentEpisode.producerSequence = producerSequence as number;
    }
    return copyEvent(event);
  };

  const validateInput = (
    input: SemanticJourneyEventInput
  ): ValidatedSemanticJourneyEventInput | undefined => {
    try {
      return validateSemanticJourneyEventInput(config.catalogue, input);
    } catch {
      notifyDrop("invalid");
      return undefined;
    }
  };

  const createIndependentContext = (
    currentEpisode: LocalEpisode
  ): SemanticJourneyContext =>
    Object.freeze({
      journeyId: currentEpisode.root.journeyId,
      traceId: currentEpisode.root.traceId,
      spanId: createSpanId(config.randomBytes),
      traceFlags: currentEpisode.root.traceFlags,
    });

  const contextForCause = (
    currentEpisode: LocalEpisode,
    causedByEventId: string | undefined,
    request: boolean
  ): SemanticJourneyContext => {
    const causeContext = causedByEventId
      ? contextByEventId.get(causedByEventId)
      : undefined;
    if (request) {
      return createRequestJourneyContext(
        causeContext ?? currentEpisode.root,
        config.randomBytes
      );
    }
    if (!causeContext) {
      return createIndependentContext(currentEpisode);
    }
    return createChildJourneyContext(causeContext, config.randomBytes);
  };

  const track = (
    input: SemanticJourneyEventInput,
    options: SemanticJourneyTrackOptions = {}
  ): SemanticJourneyEvent | undefined => {
    if (!config.enabled || destroyed) {
      return undefined;
    }

    try {
      const causedByEventId = options.causedByEventId;
      if (causedByEventId !== undefined && !isEventId(causedByEventId)) {
        notifyDrop("invalid");
        return undefined;
      }
      const validated = validateInput(input);
      if (!validated) {
        return undefined;
      }
      const nowEpochMs = config.now();
      const currentEpisode = ensureEpisode(nowEpochMs);
      const context = contextForCause(
        currentEpisode,
        causedByEventId,
        false
      );
      return appendValidated(
        validated,
        {
          context,
          ...(causedByEventId ? { causedByEventId } : {}),
        },
        nowEpochMs
      );
    } catch {
      notifyDrop("invalid");
      return undefined;
    }
  };

  const addConsequence = (
    receipt: SemanticJourneyConsequenceReceipt,
    parentContext: SemanticJourneyContext,
    causedByEventId: string,
    producerId: string,
    producerSequence: number
  ): SemanticJourneyEvent | undefined => {
    const definition = config.catalogue.definitions[receipt.name];
    if (!definition) {
      return undefined;
    }
    const validated = validateInput({
      name: receipt.name,
      category: definition.category,
      phase: receipt.phase,
      outcome: receipt.outcome,
      target: { type: "effect", id: receipt.effect },
    });
    if (!validated) {
      return undefined;
    }

    const context = createChildJourneyContext(parentContext, config.randomBytes);
    return appendValidated(
      validated,
      {
        context,
        causedByEventId,
        channel: "backend",
        runtime: "server",
        producerId,
        producerSequence,
      },
      config.now()
    );
  };

  const beginRequest = (
    input: SemanticJourneyEventInput,
    options: SemanticJourneyTrackOptions = {}
  ): SemanticJourneyRequestLink | undefined => {
    if (!config.enabled || destroyed) {
      return undefined;
    }

    try {
      const causedByEventId = options.causedByEventId;
      if (causedByEventId !== undefined && !isEventId(causedByEventId)) {
        notifyDrop("invalid");
        return undefined;
      }
      const validated = validateInput(input);
      if (!validated) {
        return undefined;
      }
      const nowEpochMs = config.now();
      const currentEpisode = ensureEpisode(nowEpochMs);
      const requestContext = contextForCause(
        currentEpisode,
        causedByEventId,
        true
      );
      const requestEvent = appendValidated(
        validated,
        {
          context: requestContext,
          ...(causedByEventId ? { causedByEventId } : {}),
        },
        nowEpochMs
      );
      if (!requestEvent) {
        return undefined;
      }

      const requestEventId = requestEvent.eventId;
      const traceparent = formatTraceparent(requestContext);
      let completed = false;
      return Object.freeze({
        requestEvent,
        traceparent,
        complete: (
          consequenceReceiptHeader: string | null | undefined
        ): readonly SemanticJourneyEvent[] => {
          if (completed || destroyed) {
            return [];
          }
          completed = true;
          try {
            const receipts = parseSemanticJourneyReceipts(
              consequenceReceiptHeader,
              config.catalogue
            );
            if (receipts.length === 0) {
              return [];
            }
            const producerId = createProducerId(config.randomBytes);
            const added: SemanticJourneyEvent[] = [];
            let parentContext = requestContext;
            let causeEventId = requestEventId;
            let producerSequence = 1;
            for (const receipt of receipts) {
              const consequence = addConsequence(
                receipt,
                parentContext,
                causeEventId,
                producerId,
                producerSequence
              );
              if (!consequence) {
                continue;
              }
              const storedContext = contextByEventId.get(consequence.eventId);
              if (storedContext) {
                parentContext = storedContext;
              }
              causeEventId = consequence.eventId;
              producerSequence += 1;
              added.push(consequence);
            }
            return added;
          } catch {
            notifyDrop("invalid");
            return [];
          }
        },
      });
    } catch {
      notifyDrop("invalid");
      return undefined;
    }
  };

  const sendWithTimeout = async (
    batch: SemanticJourneyAggregateBatch,
    keepalive: boolean
  ): Promise<void> => {
    if (!config.aggregateEndpoint) {
      return;
    }
    const controller = new AbortController();
    activeTransportController = controller;

    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof globalThis.setTimeout>;
      function cleanup(): void {
        globalThis.clearTimeout(timer);
        controller.signal.removeEventListener("abort", rejectAborted);
      }
      function rejectAborted(): void {
        cleanup();
        reject(new SemanticJourneyTransportError("aborted", true));
      }
      timer = globalThis.setTimeout(() => {
        controller.abort();
      }, config.requestTimeoutMs);
      controller.signal.addEventListener("abort", rejectAborted, { once: true });

      let transportPromise: Promise<void>;
      try {
        transportPromise = Promise.resolve(config.aggregateTransport({
          endpoint: config.aggregateEndpoint as string,
          body: JSON.stringify(batch),
          headers: {
            "content-type": CONTENT_TYPE,
            "x-idempotency-key": batch.batchId,
          },
          signal: controller.signal,
          keepalive,
        }));
      } catch (error) {
        cleanup();
        reject(error);
        return;
      }

      void transportPromise.then(
        () => {
          cleanup();
          resolve();
        },
        (error: unknown) => {
          cleanup();
          reject(error);
        }
      );
    }).finally(() => {
      if (activeTransportController === controller) {
        activeTransportController = undefined;
      }
    });
  };

  const sendBatch = async (
    batch: SemanticJourneyAggregateBatch,
    keepalive: boolean,
    signal: AbortSignal
  ): Promise<"sent" | "retained" | "discarded"> => {
    for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
      if (destroyed || signal.aborted) {
        return "retained";
      }
      try {
        await sendWithTimeout(batch, keepalive);
        return "sent";
      } catch (error) {
        const transportError =
          error instanceof SemanticJourneyTransportError ? error : undefined;
        if (transportError && !transportError.retryable) {
          notifyDrop("transport-rejected");
          return "discarded";
        }
        if (attempt >= config.maxRetries) {
          return "retained";
        }

        const retryAfterMs = transportError?.retryAfterMs;
        const delayMs =
          retryAfterMs === undefined
            ? jitteredDelay(attempt, config)
            : Math.min(config.retryMaxDelayMs, Math.max(0, retryAfterMs));
        try {
          await config.retryDelay(delayMs, signal);
        } catch {
          return "retained";
        }
      }
    }
    return "retained";
  };

  const flushInternal = async (keepalive: boolean): Promise<void> => {
    if (!config.enabled || destroyed || !config.aggregateEndpoint) {
      return;
    }
    const generation = aggregateGeneration;
    const signal = aggregateController.signal;
    for (
      let sentBatchCount = 0;
      sentBatchCount < config.maxBatchesPerFlush;
      sentBatchCount += 1
    ) {
      const batch =
        pendingBatch ??
        aggregateStore.createBatch({
          batchId: createEventId(config.randomBytes),
          nowEpochMs: config.now(),
          maxCounters: config.aggregateMaxCounters,
          maxBytes: config.aggregateMaxBytes,
        });
      if (!batch) {
        return;
      }
      pendingBatch = batch;

      const result = await sendBatch(batch, keepalive, signal);
      if (generation !== aggregateGeneration || signal.aborted) {
        return;
      }
      if (result === "retained") {
        return;
      }
      aggregateStore.acknowledge(batch);
      pendingBatch = undefined;
    }
  };

  const startFlush = (keepalive: boolean): Promise<void> => {
    if (flushInFlight) {
      return flushInFlight;
    }
    flushInFlight = flushInternal(keepalive)
      .catch(() => undefined)
      .finally(() => {
        flushInFlight = undefined;
      });
    return flushInFlight;
  };

  const flush = (): Promise<void> => startFlush(false);

  const getEvents = (): readonly SemanticJourneyEvent[] => {
    if (!config.enabled || destroyed) {
      return [];
    }
    try {
      pruneExpired(config.now());
      return queue.map(({ event }) => copyEvent(event));
    } catch {
      return [];
    }
  };

  const reconstruct = (): SemanticJourneyReplay =>
    reconstructSemanticJourney(config.catalogue, getEvents());

  const rotate = (): void => {
    if (!config.enabled || destroyed) {
      return;
    }
    rotateAt(config.now());
  };

  const clear = (): void => {
    if (destroyed) {
      return;
    }
    aggregateGeneration += 1;
    aggregateController.abort();
    aggregateController = new AbortController();
    activeTransportController?.abort();
    pendingBatch = undefined;
    clearLocalQueue();
    aggregateStore.clear();
    episode = undefined;
  };

  const onLifecycleFlush = (): void => {
    void startFlush(true);
  };

  const onVisibilityChange = (): void => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      void startFlush(true);
    }
  };

  if (
    config.enabled &&
    config.autoFlush &&
    config.aggregateEndpoint &&
    !destroyed
  ) {
    interval = globalThis.setInterval(
      () => void flush(),
      config.aggregateFlushIntervalMs
    );
    if (typeof interval === "object" && interval && "unref" in interval) {
      (interval as { unref(): void }).unref();
    }
    if (typeof window !== "undefined") {
      window.addEventListener("pagehide", onLifecycleFlush);
    }
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibilityChange);
    }
  }

  const destroy = (): void => {
    if (destroyed) {
      return;
    }
    destroyed = true;
    aggregateGeneration += 1;
    aggregateController.abort();
    activeTransportController?.abort();
    pendingBatch = undefined;
    if (interval !== undefined) {
      globalThis.clearInterval(interval);
      interval = undefined;
    }
    if (typeof window !== "undefined") {
      window.removeEventListener("pagehide", onLifecycleFlush);
    }
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    }
    clearLocalQueue();
    aggregateStore.clear();
    episode = undefined;
  };

  return Object.freeze({
    source: config.source,
    channel: config.channel,
    runtime: config.runtime,
    track,
    beginRequest,
    getEvents,
    reconstruct,
    flush,
    rotate,
    clear,
    destroy,
  });
}

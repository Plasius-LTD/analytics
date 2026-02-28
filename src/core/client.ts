import type {
  AnalyticsChannel,
  AnalyticsContext,
  AnalyticsRuntime,
  AnalyticsTransport,
  LocalSpaceAnalyticsClient,
  LocalSpaceAnalyticsConfig,
  LocalSpaceAnalyticsEvent,
  LocalSpaceAnalyticsRecord,
  ResolvedLocalSpaceAnalyticsConfig,
} from "./types.js";

const DEFAULT_FLUSH_INTERVAL_MS = 5000;
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_MAX_QUEUE_SIZE = 500;
const DEFAULT_STORAGE_KEY_PREFIX = "plasius.analytics.local-space.queue";

const JSON_CONTENT_TYPE_HEADER = "application/json";

function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function isBrowserEnvironment(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

function resolveRuntime(
  explicitRuntime: AnalyticsRuntime | undefined,
  previousRuntime: AnalyticsRuntime | undefined
): AnalyticsRuntime {
  if (explicitRuntime) {
    return explicitRuntime;
  }

  if (previousRuntime) {
    return previousRuntime;
  }

  return isBrowserEnvironment() ? "browser" : "server";
}

function resolveChannel(
  explicitChannel: AnalyticsChannel | undefined,
  runtime: AnalyticsRuntime,
  previousChannel: AnalyticsChannel | undefined
): AnalyticsChannel {
  if (explicitChannel) {
    return explicitChannel;
  }

  if (previousChannel) {
    return previousChannel;
  }

  return runtime === "server" ? "backend" : "frontend";
}

function sanitizeStorageSourceSegment(source: string): string {
  const normalized = source.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  return normalized || "unknown-source";
}

function buildDefaultStorageKey(source: string, channel: AnalyticsChannel): string {
  return `${DEFAULT_STORAGE_KEY_PREFIX}.${channel}.${sanitizeStorageSourceSegment(source)}`;
}

function resolveStorageKey(
  configStorageKey: string | undefined,
  source: string,
  channel: AnalyticsChannel,
  previous?: ResolvedLocalSpaceAnalyticsConfig
): string {
  const explicitStorageKey = configStorageKey?.trim();
  if (explicitStorageKey) {
    return explicitStorageKey;
  }

  const defaultStorageKey = buildDefaultStorageKey(source, channel);
  if (!previous) {
    return defaultStorageKey;
  }

  const previousDefaultStorageKey = buildDefaultStorageKey(
    previous.source,
    previous.channel
  );

  return previous.storageKey === previousDefaultStorageKey
    ? defaultStorageKey
    : previous.storageKey;
}

async function defaultTransport({
  endpoint,
  body,
  headers,
  keepalive,
}: {
  endpoint: string;
  body: string;
  headers: Record<string, string>;
  keepalive: boolean;
}): Promise<void> {
  if (typeof fetch !== "function") {
    return;
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body,
    keepalive,
  });

  if (!response.ok) {
    throw new Error(`Analytics transport failed with status ${response.status}.`);
  }
}

function toPositiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  const rounded = Math.floor(value);
  return rounded > 0 ? rounded : fallback;
}

function resolveSessionId(
  configSessionId: string | undefined,
  previousSessionId: string | undefined
): string {
  const explicitSessionId = configSessionId?.trim();
  if (explicitSessionId) {
    return explicitSessionId;
  }

  if (previousSessionId) {
    return previousSessionId;
  }

  return createId("session");
}

function resolveConfig(
  config: LocalSpaceAnalyticsConfig,
  previous?: ResolvedLocalSpaceAnalyticsConfig
): ResolvedLocalSpaceAnalyticsConfig {
  const source = (config.source ?? previous?.source ?? "").trim();
  if (!source) {
    throw new Error("Local space analytics requires a non-empty source.");
  }

  const runtime = resolveRuntime(config.runtime, previous?.runtime);
  const channel = resolveChannel(config.channel, runtime, previous?.channel);

  const endpointCandidate =
    config.endpoint !== undefined ? config.endpoint : previous?.endpoint;
  const endpoint = endpointCandidate?.trim() || undefined;

  return {
    source,
    endpoint,
    channel,
    runtime,
    sessionId: resolveSessionId(config.sessionId, previous?.sessionId),
    injectChannelContext:
      config.injectChannelContext ?? previous?.injectChannelContext ?? true,
    enabled: config.enabled ?? previous?.enabled ?? true,
    defaultContext: {
      ...(previous?.defaultContext ?? {}),
      ...(config.defaultContext ?? {}),
    },
    headers: {
      "content-type": JSON_CONTENT_TYPE_HEADER,
      ...(previous?.headers ?? {}),
      ...(config.headers ?? {}),
    },
    flushIntervalMs: toPositiveInteger(
      config.flushIntervalMs ?? previous?.flushIntervalMs,
      DEFAULT_FLUSH_INTERVAL_MS
    ),
    batchSize: toPositiveInteger(config.batchSize ?? previous?.batchSize, DEFAULT_BATCH_SIZE),
    maxQueueSize: toPositiveInteger(
      config.maxQueueSize ?? previous?.maxQueueSize,
      DEFAULT_MAX_QUEUE_SIZE
    ),
    storageKey: resolveStorageKey(config.storageKey, source, channel, previous),
    transport: (config.transport ?? previous?.transport ?? defaultTransport) as AnalyticsTransport,
    onError: config.onError ?? previous?.onError,
  };
}

function isStoredRecordCandidate(value: unknown): value is LocalSpaceAnalyticsRecord {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<LocalSpaceAnalyticsRecord>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.component === "string" &&
    typeof candidate.action === "string" &&
    typeof candidate.source === "string" &&
    typeof candidate.sessionId === "string" &&
    typeof candidate.timestamp === "number"
  );
}

function normalizeStoredRecord(
  value: LocalSpaceAnalyticsRecord,
  fallbackConfig: ResolvedLocalSpaceAnalyticsConfig
): LocalSpaceAnalyticsRecord {
  const context =
    value.context && typeof value.context === "object" && !Array.isArray(value.context)
      ? value.context
      : {};

  const channel: AnalyticsChannel =
    value.channel === "frontend" || value.channel === "backend"
      ? value.channel
      : fallbackConfig.channel;

  const runtime: AnalyticsRuntime =
    value.runtime === "browser" || value.runtime === "server"
      ? value.runtime
      : fallbackConfig.runtime;

  return {
    ...value,
    channel,
    runtime,
    context,
  };
}

function readQueue(
  storageKey: string,
  fallbackConfig: ResolvedLocalSpaceAnalyticsConfig
): LocalSpaceAnalyticsRecord[] {
  if (!isBrowserEnvironment() || typeof window.localStorage === "undefined") {
    return [];
  }

  try {
    const rawValue = window.localStorage.getItem(storageKey);
    if (!rawValue) {
      return [];
    }

    const parsed = JSON.parse(rawValue);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter(isStoredRecordCandidate)
      .map((record) => normalizeStoredRecord(record, fallbackConfig));
  } catch {
    return [];
  }
}

function writeQueue(storageKey: string, queue: LocalSpaceAnalyticsRecord[]): void {
  if (!isBrowserEnvironment() || typeof window.localStorage === "undefined") {
    return;
  }

  try {
    if (queue.length === 0) {
      window.localStorage.removeItem(storageKey);
      return;
    }

    window.localStorage.setItem(storageKey, JSON.stringify(queue));
  } catch {
    // Ignored by design: storage quota errors should never break host app UX.
  }
}

function createPayload(config: ResolvedLocalSpaceAnalyticsConfig, events: LocalSpaceAnalyticsRecord[]): string {
  return JSON.stringify({
    source: config.source,
    channel: config.channel,
    runtime: config.runtime,
    sentAt: Date.now(),
    events,
  });
}

function createMergedContext(
  config: ResolvedLocalSpaceAnalyticsConfig,
  eventChannel: AnalyticsChannel,
  eventContext: AnalyticsContext | undefined
): AnalyticsContext {
  const mergedContext: AnalyticsContext = {
    ...config.defaultContext,
    ...(eventContext ?? {}),
  };

  if (config.injectChannelContext) {
    if (mergedContext.analyticsChannel === undefined) {
      mergedContext.analyticsChannel = eventChannel;
    }
    if (mergedContext.analyticsRuntime === undefined) {
      mergedContext.analyticsRuntime = config.runtime;
    }
  }

  return mergedContext;
}

export function createLocalSpaceAnalyticsClient(
  config: LocalSpaceAnalyticsConfig
): LocalSpaceAnalyticsClient {
  let resolvedConfig = resolveConfig(config);
  let queue = readQueue(resolvedConfig.storageKey, resolvedConfig).slice(
    -resolvedConfig.maxQueueSize
  );

  let flushTimer: ReturnType<typeof setInterval> | null = null;
  let isFlushing = false;
  let flushQueuedAfterCurrent = false;
  let isDestroyed = false;

  const persistQueue = () => writeQueue(resolvedConfig.storageKey, queue);

  const trimQueue = () => {
    if (queue.length <= resolvedConfig.maxQueueSize) {
      return;
    }

    queue = queue.slice(queue.length - resolvedConfig.maxQueueSize);
  };

  const flushWithBeacon = (): boolean => {
    if (!resolvedConfig.endpoint || queue.length === 0) {
      return false;
    }

    if (
      typeof navigator === "undefined" ||
      typeof navigator.sendBeacon !== "function"
    ) {
      return false;
    }

    const events = queue.slice(0, resolvedConfig.batchSize);

    try {
      const body = createPayload(resolvedConfig, events);
      const blob = new Blob([body], { type: JSON_CONTENT_TYPE_HEADER });
      const sent = navigator.sendBeacon(resolvedConfig.endpoint, blob);

      if (sent) {
        queue = queue.slice(events.length);
        persistQueue();
      }

      return sent;
    } catch {
      return false;
    }
  };

  const flush = async (): Promise<void> => {
    if (isDestroyed || !resolvedConfig.enabled || !resolvedConfig.endpoint) {
      return;
    }

    if (queue.length === 0) {
      return;
    }

    if (isFlushing) {
      flushQueuedAfterCurrent = true;
      return;
    }

    const events = queue.slice(0, resolvedConfig.batchSize);
    const body = createPayload(resolvedConfig, events);

    isFlushing = true;

    try {
      await resolvedConfig.transport({
        endpoint: resolvedConfig.endpoint,
        body,
        headers: resolvedConfig.headers,
        keepalive: true,
      });

      queue = queue.slice(events.length);
      persistQueue();
    } catch (error) {
      resolvedConfig.onError?.(error);
    } finally {
      isFlushing = false;

      if (flushQueuedAfterCurrent) {
        flushQueuedAfterCurrent = false;
        if (queue.length > 0) {
          void flush();
        }
      }
    }
  };

  const startFlushTimer = () => {
    if (flushTimer) {
      clearInterval(flushTimer);
      flushTimer = null;
    }

    if (!resolvedConfig.enabled) {
      return;
    }

    flushTimer = setInterval(() => {
      void flush();
    }, resolvedConfig.flushIntervalMs);
  };

  const handleVisibilityChange = () => {
    if (typeof document === "undefined") {
      return;
    }

    if (document.visibilityState !== "hidden") {
      return;
    }

    if (!flushWithBeacon()) {
      void flush();
    }
  };

  const handlePageHide = () => {
    if (!flushWithBeacon()) {
      void flush();
    }
  };

  if (isBrowserEnvironment()) {
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pagehide", handlePageHide);
  }

  startFlushTimer();

  const trackWithChannel = (
    event: Omit<LocalSpaceAnalyticsEvent, "channel">,
    channel: AnalyticsChannel
  ) => {
    const trackableEvent: LocalSpaceAnalyticsEvent = {
      ...event,
      channel,
    };
    track(trackableEvent);
  };

  const track = (event: LocalSpaceAnalyticsEvent) => {
    if (isDestroyed || !resolvedConfig.enabled) {
      return;
    }

    const eventChannel = event.channel ?? resolvedConfig.channel;
    const requestId =
      typeof event.requestId === "string" && event.requestId.trim()
        ? event.requestId.trim()
        : undefined;

    const record: LocalSpaceAnalyticsRecord = {
      id: createId("event"),
      component: event.component,
      action: event.action,
      channel: eventChannel,
      runtime: resolvedConfig.runtime,
      label: event.label,
      href: event.href,
      variant: event.variant,
      requestId,
      source: resolvedConfig.source,
      sessionId: resolvedConfig.sessionId,
      timestamp: event.timestamp ?? Date.now(),
      context: createMergedContext(resolvedConfig, eventChannel, event.context),
    };

    queue.push(record);
    trimQueue();
    persistQueue();

    if (queue.length >= resolvedConfig.batchSize) {
      void flush();
    }
  };

  return {
    get source() {
      return resolvedConfig.source;
    },

    get channel() {
      return resolvedConfig.channel;
    },

    track,

    trackFrontend(event) {
      trackWithChannel(event, "frontend");
    },

    trackBackend(event) {
      trackWithChannel(event, "backend");
    },

    flush,

    updateConfig(nextConfig: Partial<LocalSpaceAnalyticsConfig>) {
      if (isDestroyed) {
        return;
      }

      const previousStorageKey = resolvedConfig.storageKey;
      resolvedConfig = resolveConfig(
        {
          ...resolvedConfig,
          ...nextConfig,
          source: nextConfig.source ?? resolvedConfig.source,
        },
        resolvedConfig
      );

      if (previousStorageKey !== resolvedConfig.storageKey) {
        writeQueue(previousStorageKey, []);
        persistQueue();
      }

      startFlushTimer();

      if (resolvedConfig.endpoint && queue.length > 0) {
        void flush();
      }
    },

    getConfig() {
      return resolvedConfig;
    },

    destroy() {
      if (isDestroyed) {
        return;
      }

      isDestroyed = true;

      if (flushTimer) {
        clearInterval(flushTimer);
        flushTimer = null;
      }

      if (isBrowserEnvironment()) {
        document.removeEventListener("visibilitychange", handleVisibilityChange);
        window.removeEventListener("pagehide", handlePageHide);
      }

      void flush();
    },
  };
}

type ChannelPinnedConfig = Omit<LocalSpaceAnalyticsConfig, "channel" | "runtime"> & {
  runtime?: AnalyticsRuntime;
};

export function createFrontendAnalyticsClient(
  config: ChannelPinnedConfig
): LocalSpaceAnalyticsClient {
  return createLocalSpaceAnalyticsClient({
    ...config,
    channel: "frontend",
    runtime: config.runtime ?? "browser",
  });
}

export function createBackendAnalyticsClient(
  config: ChannelPinnedConfig
): LocalSpaceAnalyticsClient {
  return createLocalSpaceAnalyticsClient({
    ...config,
    channel: "backend",
    runtime: config.runtime ?? "server",
  });
}

export function createNoopLocalSpaceAnalyticsClient(
  source = "noop",
  channel: AnalyticsChannel = "frontend"
): LocalSpaceAnalyticsClient {
  const runtime = isBrowserEnvironment() ? "browser" : "server";
  const noopConfig: ResolvedLocalSpaceAnalyticsConfig = {
    source,
    channel,
    runtime,
    sessionId: createId("session"),
    injectChannelContext: true,
    enabled: false,
    endpoint: undefined,
    defaultContext: {},
    headers: { "content-type": JSON_CONTENT_TYPE_HEADER },
    flushIntervalMs: DEFAULT_FLUSH_INTERVAL_MS,
    batchSize: DEFAULT_BATCH_SIZE,
    maxQueueSize: DEFAULT_MAX_QUEUE_SIZE,
    storageKey: buildDefaultStorageKey(source, channel),
    transport: async () => undefined,
    onError: undefined,
  };

  return {
    source,
    channel,
    track: () => undefined,
    trackFrontend: () => undefined,
    trackBackend: () => undefined,
    flush: async () => undefined,
    updateConfig: () => undefined,
    getConfig: () => noopConfig,
    destroy: () => undefined,
  };
}

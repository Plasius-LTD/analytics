import type {
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
const DEFAULT_STORAGE_KEY = "plasius.analytics.local-space.queue";

const JSON_CONTENT_TYPE_HEADER = "application/json";

function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
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

function resolveConfig(
  config: LocalSpaceAnalyticsConfig,
  previous?: ResolvedLocalSpaceAnalyticsConfig
): ResolvedLocalSpaceAnalyticsConfig {
  const source = (config.source ?? previous?.source ?? "").trim();

  if (!source) {
    throw new Error("Local space analytics requires a non-empty source.");
  }

  return {
    source,
    endpoint: config.endpoint?.trim(),
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
    storageKey: (config.storageKey ?? previous?.storageKey ?? DEFAULT_STORAGE_KEY).trim(),
    transport: (config.transport ?? previous?.transport ?? defaultTransport) as AnalyticsTransport,
    onError: config.onError ?? previous?.onError,
  };
}

function isBrowserEnvironment(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

function readQueue(storageKey: string): LocalSpaceAnalyticsRecord[] {
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

    return parsed.filter(isStoredRecordCandidate);
  } catch {
    return [];
  }
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

function createPayload(source: string, events: LocalSpaceAnalyticsRecord[]): string {
  return JSON.stringify({
    source,
    sentAt: Date.now(),
    events,
  });
}

export function createLocalSpaceAnalyticsClient(
  config: LocalSpaceAnalyticsConfig
): LocalSpaceAnalyticsClient {
  let resolvedConfig = resolveConfig(config);
  const sessionId = createId("session");
  let queue = readQueue(resolvedConfig.storageKey).slice(-resolvedConfig.maxQueueSize);

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
      const body = createPayload(resolvedConfig.source, events);
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
    const body = createPayload(resolvedConfig.source, events);

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

  return {
    get source() {
      return resolvedConfig.source;
    },

    track(event: LocalSpaceAnalyticsEvent) {
      if (isDestroyed || !resolvedConfig.enabled) {
        return;
      }

      const record: LocalSpaceAnalyticsRecord = {
        id: createId("event"),
        component: event.component,
        action: event.action,
        label: event.label,
        href: event.href,
        variant: event.variant,
        source: resolvedConfig.source,
        sessionId,
        timestamp: event.timestamp ?? Date.now(),
        context: {
          ...resolvedConfig.defaultContext,
          ...(event.context ?? {}),
        },
      };

      queue.push(record);
      trimQueue();
      persistQueue();

      if (queue.length >= resolvedConfig.batchSize) {
        void flush();
      }
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

export function createNoopLocalSpaceAnalyticsClient(
  source = "noop"
): LocalSpaceAnalyticsClient {
  const noopConfig: ResolvedLocalSpaceAnalyticsConfig = {
    source,
    enabled: false,
    endpoint: undefined,
    defaultContext: {},
    headers: { "content-type": JSON_CONTENT_TYPE_HEADER },
    flushIntervalMs: DEFAULT_FLUSH_INTERVAL_MS,
    batchSize: DEFAULT_BATCH_SIZE,
    maxQueueSize: DEFAULT_MAX_QUEUE_SIZE,
    storageKey: DEFAULT_STORAGE_KEY,
    transport: async () => undefined,
    onError: undefined,
  };

  return {
    source,
    track: () => undefined,
    flush: async () => undefined,
    updateConfig: () => undefined,
    getConfig: () => noopConfig,
    destroy: () => undefined,
  };
}

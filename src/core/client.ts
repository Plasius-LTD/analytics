import type {
  AnalyticsChannel,
  AnalyticsContext,
  AnalyticsEventKind,
  AnalyticsRuntime,
  AnalyticsTransport,
  LocalSpaceAnalyticsClient,
  LocalSpaceAnalyticsConfig,
  LocalSpaceAnalyticsErrorDetails,
  LocalSpaceAnalyticsEvent,
  LocalSpaceAnalyticsRecord,
  LocalSpaceErrorReportInput,
  LocalSpaceIssueReport,
  ResolvedLocalSpaceAnalyticsConfig,
  ResolvedLocalSpaceErrorReportingConfig,
} from "./types.js";
import { createSchema, field } from "@plasius/schema";

const DEFAULT_FLUSH_INTERVAL_MS = 5000;
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_MAX_QUEUE_SIZE = 500;
const DEFAULT_STORAGE_KEY_PREFIX = "plasius.analytics.local-space.queue";

const DEFAULT_ERROR_MESSAGE_LENGTH = 240;
const DEFAULT_ERROR_STACK_LENGTH = 1800;
const DEFAULT_ERROR_COMPONENT_STACK_LENGTH = 1800;
const DEFAULT_ERROR_CONTEXT_DEPTH = 4;
const DEFAULT_ERROR_CONTEXT_BREADTH = 20;
const DEFAULT_ERROR_TAG_COUNT = 10;
const DEFAULT_ERROR_THRESHOLD_COUNT = 5;
const DEFAULT_ERROR_THRESHOLD_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_ERROR_REDACT_KEYS = [
  "email",
  "phone",
  "name",
  "address",
  "token",
  "password",
  "secret",
  "cookie",
  "session",
  "auth",
  "ssn",
  "dob",
  "user",
];

const JSON_CONTENT_TYPE_HEADER = "application/json";
const LOCALHOST_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

const PlainLogValueSchema = createSchema(
  {
    value: field.generalText().PID({
      classification: "none",
      action: "none",
      logHandling: "plain",
      purpose: "analytics log-safe value",
    }),
  },
  "analytics-log-safe-value",
  { version: "1.0.0", piiEnforcement: "none" }
);

const SensitiveLogValueSchema = createSchema(
  {
    value: field.generalText().PID({
      classification: "high",
      action: "none",
      logHandling: "redact",
      purpose: "analytics private value",
    }),
  },
  "analytics-private-log-value",
  { version: "1.0.0", piiEnforcement: "none" }
);

function applySchemaLogHandling(value: string, sensitive: boolean): string {
  const schema = sensitive ? SensitiveLogValueSchema : PlainLogValueSchema;
  const sanitized = schema.sanitizeForLog({ value }, (input) => `p(${String(input ?? "")})`);
  return typeof sanitized.value === "string" ? sanitized.value : "";
}

const REDACTED_VALUE = applySchemaLogHandling("sensitive", true) || "[REDACTED]";

interface IssueAggregateState {
  timestamps: number[];
  sample: LocalSpaceAnalyticsErrorDetails;
  lastTriggeredAt?: number;
}

interface CrashIdentifierEntry {
  key: string;
  value: string;
}

interface SanitizedErrorContextResult {
  context: AnalyticsContext;
  identifiers: CrashIdentifierEntry[];
}

const CrashIdentitySchema = createSchema(
  {
    source: field.generalText()
      .PID({
        classification: "none",
        action: "none",
        logHandling: "plain",
        purpose: "analytics source identifier",
      })
      .optional(),
    channel: field.generalText()
      .PID({
        classification: "none",
        action: "none",
        logHandling: "plain",
        purpose: "analytics channel identifier",
      })
      .optional(),
    runtime: field.generalText()
      .PID({
        classification: "none",
        action: "none",
        logHandling: "plain",
        purpose: "analytics runtime identifier",
      })
      .optional(),
    sessionId: field.generalText()
      .PID({
        classification: "high",
        action: "hash",
        logHandling: "redact",
        purpose: "client session identifier",
      })
      .optional(),
    userAgent: field.generalText()
      .PID({
        classification: "low",
        action: "hash",
        logHandling: "pseudonym",
        purpose: "browser user agent",
      })
      .optional(),
    platform: field.generalText()
      .PID({
        classification: "low",
        action: "hash",
        logHandling: "pseudonym",
        purpose: "client platform",
      })
      .optional(),
    language: field.generalText()
      .PID({
        classification: "low",
        action: "hash",
        logHandling: "pseudonym",
        purpose: "client language",
      })
      .optional(),
    timezone: field.generalText()
      .PID({
        classification: "low",
        action: "hash",
        logHandling: "pseudonym",
        purpose: "client timezone",
      })
      .optional(),
    origin: field.generalText()
      .PID({
        classification: "low",
        action: "hash",
        logHandling: "pseudonym",
        purpose: "client origin",
      })
      .optional(),
    pathname: field.generalText()
      .PID({
        classification: "low",
        action: "hash",
        logHandling: "pseudonym",
        purpose: "client route path",
      })
      .optional(),
    screenWidth: field.number()
      .PID({
        classification: "none",
        action: "none",
        logHandling: "plain",
        purpose: "viewport width",
      })
      .optional(),
    screenHeight: field.number()
      .PID({
        classification: "none",
        action: "none",
        logHandling: "plain",
        purpose: "viewport height",
      })
      .optional(),
    colorDepth: field.number()
      .PID({
        classification: "none",
        action: "none",
        logHandling: "plain",
        purpose: "screen color depth",
      })
      .optional(),
    hardwareConcurrency: field.number()
      .PID({
        classification: "none",
        action: "none",
        logHandling: "plain",
        purpose: "cpu concurrency",
      })
      .optional(),
    identifiers: field
      .array(
        field.object({
          key: field.generalText().PID({
            classification: "none",
            action: "none",
            logHandling: "plain",
            purpose: "identifier field key",
          }),
          value: field.generalText().PID({
            classification: "high",
            action: "hash",
            logHandling: "redact",
            purpose: "identifier value",
          }),
        })
      )
      .optional(),
  },
  "analytics-crash-identity",
  { version: "1.0.0", piiEnforcement: "none" }
);

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

function toNumberWithMinimum(
  value: number | undefined,
  fallback: number,
  minimum: number
): number {
  return Math.max(toPositiveInteger(value, fallback), minimum);
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

function normalizeRedactKeys(
  keys: string[] | undefined,
  previousKeys: string[] | undefined
): string[] {
  const values = keys ?? previousKeys ?? DEFAULT_ERROR_REDACT_KEYS;
  const normalized = values
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);

  if (normalized.length === 0) {
    return [...DEFAULT_ERROR_REDACT_KEYS];
  }

  return Array.from(new Set(normalized));
}

function resolveErrorReportingConfig(
  config: LocalSpaceAnalyticsConfig["errorReporting"] | undefined,
  previous?: ResolvedLocalSpaceErrorReportingConfig
): ResolvedLocalSpaceErrorReportingConfig {
  return {
    enabled: config?.enabled ?? previous?.enabled ?? true,
    secureEndpointOnly: config?.secureEndpointOnly ?? previous?.secureEndpointOnly ?? true,
    maxMessageLength: toNumberWithMinimum(
      config?.maxMessageLength ?? previous?.maxMessageLength,
      DEFAULT_ERROR_MESSAGE_LENGTH,
      16
    ),
    maxStackLength: toNumberWithMinimum(
      config?.maxStackLength ?? previous?.maxStackLength,
      DEFAULT_ERROR_STACK_LENGTH,
      32
    ),
    maxComponentStackLength: toNumberWithMinimum(
      config?.maxComponentStackLength ?? previous?.maxComponentStackLength,
      DEFAULT_ERROR_COMPONENT_STACK_LENGTH,
      32
    ),
    maxContextDepth: toNumberWithMinimum(
      config?.maxContextDepth ?? previous?.maxContextDepth,
      DEFAULT_ERROR_CONTEXT_DEPTH,
      1
    ),
    maxContextBreadth: toNumberWithMinimum(
      config?.maxContextBreadth ?? previous?.maxContextBreadth,
      DEFAULT_ERROR_CONTEXT_BREADTH,
      1
    ),
    maxTagCount: toNumberWithMinimum(
      config?.maxTagCount ?? previous?.maxTagCount,
      DEFAULT_ERROR_TAG_COUNT,
      1
    ),
    thresholdCount: toNumberWithMinimum(
      config?.thresholdCount ?? previous?.thresholdCount,
      DEFAULT_ERROR_THRESHOLD_COUNT,
      1
    ),
    thresholdWindowMs: toNumberWithMinimum(
      config?.thresholdWindowMs ?? previous?.thresholdWindowMs,
      DEFAULT_ERROR_THRESHOLD_WINDOW_MS,
      1000
    ),
    redactKeys: normalizeRedactKeys(config?.redactKeys, previous?.redactKeys),
    onThresholdReached: config?.onThresholdReached ?? previous?.onThresholdReached,
  };
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
    batchSize: toPositiveInteger(
      config.batchSize ?? previous?.batchSize,
      DEFAULT_BATCH_SIZE
    ),
    maxQueueSize: toPositiveInteger(
      config.maxQueueSize ?? previous?.maxQueueSize,
      DEFAULT_MAX_QUEUE_SIZE
    ),
    storageKey: resolveStorageKey(config.storageKey, source, channel, previous),
    errorReporting: resolveErrorReportingConfig(
      config.errorReporting,
      previous?.errorReporting
    ),
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

function isErrorDetailsCandidate(value: unknown): value is LocalSpaceAnalyticsErrorDetails {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<LocalSpaceAnalyticsErrorDetails>;
  return (
    typeof candidate.boundary === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.message === "string" &&
    typeof candidate.fingerprint === "string"
  );
}

function redactSensitiveText(value: string): string {
  return value
    .replace(
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
      REDACTED_VALUE
    )
    .replace(/\bBearer\s+[A-Za-z0-9._-]+\b/gi, `Bearer ${REDACTED_VALUE}`)
    .replace(/\b[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED_VALUE)
    .replace(/\b\d{9,}\b/g, REDACTED_VALUE)
    .replace(
      /([?&](?:token|email|phone|name|user|auth|session|password)=)[^&#\s]*/gi,
      `$1${REDACTED_VALUE}`
    );
}

function sanitizeSingleLine(value: unknown, maxLength: number): string {
  const raw = typeof value === "string" ? value : String(value ?? "");
  const flattened = raw
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!flattened) {
    return "";
  }

  const redacted = redactSensitiveText(flattened).slice(0, maxLength);
  return applySchemaLogHandling(redacted, false).slice(0, maxLength);
}

function sanitizeMultiline(value: unknown, maxLength: number): string {
  const raw = typeof value === "string" ? value : String(value ?? "");
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const sanitized = redactSensitiveText(normalized)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");

  if (!sanitized) {
    return "";
  }

  const schemaHandled = applySchemaLogHandling(sanitized, false);
  return schemaHandled.slice(0, maxLength);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function shouldRedactContextKey(
  key: string,
  resolvedErrorReporting: ResolvedLocalSpaceErrorReportingConfig
): boolean {
  const loweredKey = key.trim().toLowerCase();
  if (!loweredKey) {
    return false;
  }

  return resolvedErrorReporting.redactKeys.some(
    (candidate) => loweredKey === candidate || loweredKey.includes(candidate)
  );
}

function toIdentifierValue(value: unknown, maxLength: number): string {
  if (value === null || value === undefined) {
    return "null";
  }

  if (typeof value === "string") {
    return sanitizeSingleLine(value, maxLength) || "empty";
  }

  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return sanitizeSingleLine(String(value), maxLength) || "empty";
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return sanitizeSingleLine(safeSerialize(value), maxLength) || "empty";
}

function pushIdentifier(
  identifiers: CrashIdentifierEntry[],
  keyPath: string,
  value: unknown,
  maxLength: number
): void {
  if (!keyPath.trim()) {
    return;
  }

  identifiers.push({
    key: sanitizeSingleLine(keyPath, 160),
    value: toIdentifierValue(value, maxLength),
  });
}

function sanitizeContextValue(
  value: unknown,
  resolvedErrorReporting: ResolvedLocalSpaceErrorReportingConfig,
  depth: number,
  seen: WeakSet<object>,
  identifiers: CrashIdentifierEntry[],
  keyPath: string
): unknown {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string") {
    return sanitizeSingleLine(value, resolvedErrorReporting.maxMessageLength);
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "bigint") {
    return sanitizeSingleLine(value.toString(), resolvedErrorReporting.maxMessageLength);
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return "[circular]";
    }

    seen.add(value);

    if (depth >= resolvedErrorReporting.maxContextDepth) {
      return "[truncated]";
    }

    return value
      .slice(0, resolvedErrorReporting.maxContextBreadth)
      .map((item) =>
        sanitizeContextValue(
          item,
          resolvedErrorReporting,
          depth + 1,
          seen,
          identifiers,
          `${keyPath}[]`
        )
      );
  }

  if (isPlainObject(value)) {
    if (seen.has(value)) {
      return "[circular]";
    }

    seen.add(value);

    if (depth >= resolvedErrorReporting.maxContextDepth) {
      return "[truncated]";
    }

    const sanitized: Record<string, unknown> = {};
    const entries = Object.entries(value).slice(0, resolvedErrorReporting.maxContextBreadth);

    for (const [key, nestedValue] of entries) {
      const childPath = keyPath ? `${keyPath}.${key}` : key;
      if (shouldRedactContextKey(key, resolvedErrorReporting)) {
        sanitized[key] =
          applySchemaLogHandling(String(nestedValue ?? ""), true) || REDACTED_VALUE;
        pushIdentifier(
          identifiers,
          childPath,
          nestedValue,
          resolvedErrorReporting.maxMessageLength
        );
        continue;
      }

      sanitized[key] = sanitizeContextValue(
        nestedValue,
        resolvedErrorReporting,
        depth + 1,
        seen,
        identifiers,
        childPath
      );
    }

    return sanitized;
  }

  return sanitizeSingleLine(value, resolvedErrorReporting.maxMessageLength);
}

function sanitizeErrorContext(
  context: AnalyticsContext | undefined,
  resolvedErrorReporting: ResolvedLocalSpaceErrorReportingConfig
): SanitizedErrorContextResult {
  if (!context || !isPlainObject(context)) {
    return { context: {}, identifiers: [] };
  }

  const sanitized: AnalyticsContext = {};
  const identifiers: CrashIdentifierEntry[] = [];
  const seen = new WeakSet<object>();
  const entries = Object.entries(context).slice(0, resolvedErrorReporting.maxContextBreadth);

  for (const [key, value] of entries) {
    if (shouldRedactContextKey(key, resolvedErrorReporting)) {
      sanitized[key] = applySchemaLogHandling(String(value ?? ""), true) || REDACTED_VALUE;
      pushIdentifier(identifiers, key, value, resolvedErrorReporting.maxMessageLength);
      continue;
    }

    sanitized[key] = sanitizeContextValue(
      value,
      resolvedErrorReporting,
      1,
      seen,
      identifiers,
      key
    );
  }

  return {
    context: sanitized,
    identifiers,
  };
}

function hashString(input: string): number {
  let hash = 5381;

  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 33) ^ input.charCodeAt(index);
  }

  return hash >>> 0;
}

function hashForStorage(value: unknown): string {
  const normalized =
    typeof value === "string" ? value : safeSerialize(value);
  return `hash_${hashString(normalized).toString(16)}`;
}

function encryptForStorage(value: unknown): string {
  return `enc_${hashForStorage(value)}`;
}

function buildCrashIdentityPayload(
  config: ResolvedLocalSpaceAnalyticsConfig,
  identifiers: CrashIdentifierEntry[]
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    source: config.source,
    channel: config.channel,
    runtime: config.runtime,
    sessionId: config.sessionId,
  };

  if (isBrowserEnvironment()) {
    if (typeof navigator !== "undefined") {
      payload.userAgent = navigator.userAgent;
      payload.platform = navigator.platform;
      payload.language = navigator.language;
      payload.hardwareConcurrency = navigator.hardwareConcurrency;
    }

    if (typeof Intl !== "undefined" && typeof Intl.DateTimeFormat === "function") {
      payload.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    }

    if (typeof window !== "undefined") {
      payload.origin = window.location.origin;
      payload.pathname = window.location.pathname;
    }

    if (typeof screen !== "undefined") {
      payload.screenWidth = screen.width;
      payload.screenHeight = screen.height;
      payload.colorDepth = screen.colorDepth;
    }
  }

  if (identifiers.length > 0) {
    payload.identifiers = identifiers.slice(0, config.errorReporting.maxContextBreadth);
  }

  return payload;
}

function prepareCrashIdentityForStorage(
  payload: Record<string, unknown>
): Record<string, unknown> {
  return CrashIdentitySchema.prepareForStorage(
    payload,
    encryptForStorage,
    hashForStorage
  );
}

function normalizeTags(
  tags: string[] | undefined,
  maxTagCount: number,
  maxTagLength: number
): string[] | undefined {
  if (!Array.isArray(tags) || tags.length === 0) {
    return undefined;
  }

  const normalized = tags
    .map((tag) => sanitizeSingleLine(tag, maxTagLength))
    .filter((tag) => tag.length > 0);

  if (normalized.length === 0) {
    return undefined;
  }

  return Array.from(new Set(normalized)).slice(0, maxTagCount);
}

function safeSerialize(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

function extractErrorDetails(error: unknown): {
  name: string;
  message: string;
  stack?: string;
} {
  if (error instanceof Error) {
    return {
      name: error.name || "Error",
      message: error.message || "Unknown error",
      stack: error.stack,
    };
  }

  if (typeof error === "string") {
    return {
      name: "Error",
      message: error,
    };
  }

  if (isPlainObject(error)) {
    const name =
      typeof error.name === "string" && error.name.trim()
        ? error.name
        : "Error";

    const message =
      typeof error.message === "string" && error.message.trim()
        ? error.message
        : sanitizeSingleLine(safeSerialize(error), DEFAULT_ERROR_MESSAGE_LENGTH);

    return {
      name,
      message,
      stack: typeof error.stack === "string" ? error.stack : undefined,
    };
  }

  return {
    name: "UnknownError",
    message: sanitizeSingleLine(error, DEFAULT_ERROR_MESSAGE_LENGTH) || "Unknown error",
  };
}

function normalizeErrorReport(
  report: LocalSpaceErrorReportInput,
  resolvedErrorReporting: ResolvedLocalSpaceErrorReportingConfig,
  existingFingerprint?: string
): LocalSpaceAnalyticsErrorDetails {
  const extractedError = extractErrorDetails(report.error);

  const boundary =
    sanitizeSingleLine(report.boundary, 100) || "UnknownErrorBoundary";
  const name = sanitizeSingleLine(extractedError.name, 80) || "Error";
  const message =
    sanitizeSingleLine(extractedError.message, resolvedErrorReporting.maxMessageLength) ||
    "Unknown error";

  const stack = extractedError.stack
    ? sanitizeMultiline(extractedError.stack, resolvedErrorReporting.maxStackLength)
    : undefined;

  const componentStack = report.componentStack
    ? sanitizeMultiline(
        report.componentStack,
        resolvedErrorReporting.maxComponentStackLength
      )
    : undefined;

  const severity = report.severity === "fatal" ? "fatal" : "error";
  const handled = report.handled ?? true;

  const tags = normalizeTags(
    report.tags,
    resolvedErrorReporting.maxTagCount,
    resolvedErrorReporting.maxMessageLength
  );

  const fingerprintBase = `${boundary}|${name}|${message}|${stack?.split("\n")[0] ?? ""}|${severity}`;
  const fallbackFingerprint = `err_${hashString(fingerprintBase).toString(16)}`;
  const fingerprint =
    sanitizeSingleLine(existingFingerprint, 120) || fallbackFingerprint;

  return {
    boundary,
    name,
    message,
    fingerprint,
    handled,
    severity,
    stack,
    componentStack,
    tags,
  };
}

function normalizeStoredErrorDetails(
  value: LocalSpaceAnalyticsErrorDetails,
  resolvedErrorReporting: ResolvedLocalSpaceErrorReportingConfig
): LocalSpaceAnalyticsErrorDetails {
  return normalizeErrorReport(
    {
      boundary: value.boundary,
      error: {
        name: value.name,
        message: value.message,
        stack: value.stack,
      },
      componentStack: value.componentStack,
      handled: value.handled,
      severity: value.severity,
      tags: value.tags,
    },
    resolvedErrorReporting,
    value.fingerprint
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

  const kind: AnalyticsEventKind = value.kind === "error" ? "error" : "interaction";

  const errorDetails =
    kind === "error" && isErrorDetailsCandidate(value.error)
      ? normalizeStoredErrorDetails(value.error, fallbackConfig.errorReporting)
      : undefined;

  return {
    ...value,
    kind,
    channel,
    runtime,
    context,
    error: errorDetails,
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

function createPayload(
  config: ResolvedLocalSpaceAnalyticsConfig,
  events: LocalSpaceAnalyticsRecord[]
): string {
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

function isSecureEndpoint(endpoint: string): boolean {
  const trimmedEndpoint = endpoint.trim();

  if (!trimmedEndpoint) {
    return false;
  }

  if (trimmedEndpoint.startsWith("/")) {
    return true;
  }

  try {
    const baseUrl = isBrowserEnvironment() ? window.location.origin : "https://localhost";
    const parsedUrl = new URL(trimmedEndpoint, baseUrl);

    if (parsedUrl.protocol === "https:") {
      return true;
    }

    return parsedUrl.protocol === "http:" && LOCALHOST_HOSTS.has(parsedUrl.hostname);
  } catch {
    return false;
  }
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

  const issueAggregates = new Map<string, IssueAggregateState>();

  const persistQueue = () => writeQueue(resolvedConfig.storageKey, queue);

  const trimQueue = () => {
    if (queue.length <= resolvedConfig.maxQueueSize) {
      return;
    }

    queue = queue.slice(queue.length - resolvedConfig.maxQueueSize);
  };

  const pruneIssueState = (state: IssueAggregateState, now: number) => {
    const windowStart = now - resolvedConfig.errorReporting.thresholdWindowMs;
    state.timestamps = state.timestamps.filter((timestamp) => timestamp >= windowStart);
  };

  const buildIssueReport = (
    fingerprint: string,
    state: IssueAggregateState
  ): LocalSpaceIssueReport | null => {
    if (state.timestamps.length === 0) {
      return null;
    }

    const sortedTimestamps = [...state.timestamps].sort((a, b) => a - b);

    return {
      fingerprint,
      boundary: state.sample.boundary,
      count: sortedTimestamps.length,
      firstSeen: sortedTimestamps[0] ?? Date.now(),
      lastSeen: sortedTimestamps[sortedTimestamps.length - 1] ?? Date.now(),
      severity: state.sample.severity,
      sample: state.sample,
    };
  };

  const recordIssue = (
    details: LocalSpaceAnalyticsErrorDetails,
    timestamp: number,
    triggerThreshold: boolean
  ) => {
    const existingState = issueAggregates.get(details.fingerprint);

    if (!existingState) {
      issueAggregates.set(details.fingerprint, {
        timestamps: [timestamp],
        sample: details,
      });
    } else {
      existingState.timestamps.push(timestamp);
      existingState.sample = details;
    }

    const state = issueAggregates.get(details.fingerprint);
    if (!state) {
      return;
    }

    pruneIssueState(state, timestamp);

    if (state.timestamps.length === 0) {
      issueAggregates.delete(details.fingerprint);
      return;
    }

    if (!triggerThreshold) {
      return;
    }

    const thresholdCallback = resolvedConfig.errorReporting.onThresholdReached;
    if (!thresholdCallback) {
      return;
    }

    if (state.timestamps.length < resolvedConfig.errorReporting.thresholdCount) {
      return;
    }

    const lastTriggeredAt = state.lastTriggeredAt;
    if (
      lastTriggeredAt !== undefined &&
      timestamp - lastTriggeredAt < resolvedConfig.errorReporting.thresholdWindowMs
    ) {
      return;
    }

    state.lastTriggeredAt = timestamp;

    const report = buildIssueReport(details.fingerprint, state);
    if (!report) {
      return;
    }

    try {
      thresholdCallback({
        source: resolvedConfig.source,
        channel: resolvedConfig.channel,
        runtime: resolvedConfig.runtime,
        thresholdCount: resolvedConfig.errorReporting.thresholdCount,
        windowMs: resolvedConfig.errorReporting.thresholdWindowMs,
        report,
      });
    } catch (error) {
      resolvedConfig.onError?.(error);
    }
  };

  const getIssueReports = (): ReadonlyArray<LocalSpaceIssueReport> => {
    const now = Date.now();

    for (const [fingerprint, state] of issueAggregates.entries()) {
      pruneIssueState(state, now);
      if (state.timestamps.length === 0) {
        issueAggregates.delete(fingerprint);
      }
    }

    return Array.from(issueAggregates.entries())
      .map(([fingerprint, state]) => buildIssueReport(fingerprint, state))
      .filter((report): report is LocalSpaceIssueReport => report !== null)
      .sort((left, right) => {
        if (right.count !== left.count) {
          return right.count - left.count;
        }

        return right.lastSeen - left.lastSeen;
      });
  };

  const enqueueRecord = (record: LocalSpaceAnalyticsRecord) => {
    queue.push(record);
    trimQueue();
    persistQueue();

    if (record.kind === "error" && record.error) {
      recordIssue(record.error, record.timestamp, true);
    }

    if (queue.length >= resolvedConfig.batchSize) {
      void flush();
    }
  };

  const canSendBatchToEndpoint = (events: LocalSpaceAnalyticsRecord[]): boolean => {
    if (
      !resolvedConfig.endpoint ||
      !resolvedConfig.errorReporting.secureEndpointOnly ||
      isSecureEndpoint(resolvedConfig.endpoint)
    ) {
      return true;
    }

    if (!events.some((event) => event.kind === "error")) {
      return true;
    }

    resolvedConfig.onError?.(
      new Error(
        `Error reporting requires an https or localhost endpoint. Refused endpoint: ${resolvedConfig.endpoint}`
      )
    );
    return false;
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
    if (!canSendBatchToEndpoint(events)) {
      return false;
    }

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
    if (!canSendBatchToEndpoint(events)) {
      return;
    }

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

  for (const record of queue) {
    if (record.kind === "error" && record.error) {
      recordIssue(record.error, record.timestamp, false);
    }
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

    const kind: AnalyticsEventKind = event.kind === "error" ? "error" : "interaction";

    const normalizedError =
      kind === "error" && isErrorDetailsCandidate(event.error)
        ? normalizeStoredErrorDetails(event.error, resolvedConfig.errorReporting)
        : undefined;

    const record: LocalSpaceAnalyticsRecord = {
      id: createId("event"),
      component: event.component,
      action: event.action,
      kind,
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
      error: normalizedError,
    };

    enqueueRecord(record);
  };

  const reportError = (report: LocalSpaceErrorReportInput) => {
    if (isDestroyed || !resolvedConfig.enabled) {
      return;
    }

    if (!resolvedConfig.errorReporting.enabled) {
      return;
    }

    if (
      resolvedConfig.errorReporting.secureEndpointOnly &&
      resolvedConfig.endpoint &&
      !isSecureEndpoint(resolvedConfig.endpoint)
    ) {
      resolvedConfig.onError?.(
        new Error(
          `Error reporting requires an https or localhost endpoint. Refused endpoint: ${resolvedConfig.endpoint}`
        )
      );
      return;
    }

    const eventChannel = report.channel ?? resolvedConfig.channel;
    const timestamp = report.timestamp ?? Date.now();
    const normalizedError = normalizeErrorReport(report, resolvedConfig.errorReporting);

    const {
      context: errorContext,
      identifiers,
    } = sanitizeErrorContext(report.context, resolvedConfig.errorReporting);
    errorContext.errorFingerprint = normalizedError.fingerprint;
    errorContext.errorBoundary = normalizedError.boundary;
    errorContext.errorSeverity = normalizedError.severity;
    errorContext.errorHandled = normalizedError.handled;
    errorContext.clientIdentity = prepareCrashIdentityForStorage(
      buildCrashIdentityPayload(resolvedConfig, identifiers)
    );

    if (normalizedError.tags && normalizedError.tags.length > 0) {
      errorContext.errorTags = normalizedError.tags;
    }

    const record: LocalSpaceAnalyticsRecord = {
      id: createId("event"),
      component: normalizedError.boundary,
      action: normalizedError.handled
        ? "error_boundary_caught"
        : "unhandled_error",
      kind: "error",
      channel: eventChannel,
      runtime: resolvedConfig.runtime,
      label: normalizedError.fingerprint,
      source: resolvedConfig.source,
      sessionId: resolvedConfig.sessionId,
      timestamp,
      context: createMergedContext(resolvedConfig, eventChannel, errorContext),
      error: normalizedError,
    };

    enqueueRecord(record);
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

    reportError,

    getIssueReports,

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
    errorReporting: resolveErrorReportingConfig(undefined),
    transport: async () => undefined,
    onError: undefined,
  };

  return {
    source,
    channel,
    track: () => undefined,
    trackFrontend: () => undefined,
    trackBackend: () => undefined,
    reportError: () => undefined,
    getIssueReports: () => [],
    flush: async () => undefined,
    updateConfig: () => undefined,
    getConfig: () => noopConfig,
    destroy: () => undefined,
  };
}

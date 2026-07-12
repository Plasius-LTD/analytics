/** Bounded aggregate request passed to an injectable transport. */
export interface SemanticJourneyAggregateTransportRequest {
  readonly endpoint: string;
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  readonly keepalive?: boolean;
}

/** Transport contract for one unlinkable aggregate batch. */
export type SemanticJourneyAggregateTransport = (
  request: SemanticJourneyAggregateTransportRequest,
) => Promise<void>;

/** Stable transport failure classes that never contain request data. */
export type SemanticJourneyTransportErrorCode =
  | "aborted"
  | "network_failure"
  | "rejected";

/** Generic, bounded aggregate transport failure. */
export class SemanticJourneyTransportError extends Error {
  public constructor(
    public readonly code: SemanticJourneyTransportErrorCode,
    public readonly retryable: boolean,
    public readonly status?: number,
    public readonly retryAfterMs?: number,
  ) {
    super(`semantic journey aggregate transport ${code}`);
    this.name = "SemanticJourneyTransportError";
  }
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const MAX_RETRY_AFTER_MS = 5 * 60 * 1000;
const RELATIVE_ENDPOINT_PATTERN = /^\/(?!\/)[\x21-\x7e]*$/;

function resolveBaseUrl(explicitBaseUrl?: string): string | undefined {
  if (explicitBaseUrl) {
    return explicitBaseUrl;
  }
  if (typeof window !== "undefined" && window.location?.origin) {
    return window.location.origin;
  }
  return undefined;
}

/** Returns whether an endpoint is HTTPS, same-origin-relative, or localhost. */
export function isSecureSemanticJourneyEndpoint(
  endpoint: string,
  baseUrl?: string,
): boolean {
  const trimmed = endpoint.trim();
  if (!trimmed || trimmed !== endpoint || trimmed.length > 2_048) {
    return false;
  }

  const resolvedBaseUrl = resolveBaseUrl(baseUrl);
  const isRelativePath = trimmed.startsWith("/");
  if (
    isRelativePath &&
    (!RELATIVE_ENDPOINT_PATTERN.test(trimmed) ||
      trimmed.includes("\\") ||
      !resolvedBaseUrl)
  ) {
    return false;
  }

  try {
    const parsedBase = resolvedBaseUrl ? new URL(resolvedBaseUrl) : undefined;
    const parsed = resolvedBaseUrl
      ? new URL(trimmed, resolvedBaseUrl)
      : new URL(trimmed);
    if (isRelativePath && parsedBase && parsed.origin !== parsedBase.origin) {
      return false;
    }
    if (parsed.protocol === "https:") {
      return true;
    }
    return parsed.protocol === "http:" && LOCAL_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

const HTTP_DATE_PATTERN = /^(?:[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT|[A-Za-z]+, \d{2}-[A-Za-z]{3}-\d{2} \d{2}:\d{2}:\d{2} GMT|[A-Za-z]{3} [A-Za-z]{3} [ \d]\d \d{2}:\d{2}:\d{2} \d{4})$/u;

function parseRetryAfter(value: string | null, nowEpochMs: number): number | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  if (/^(0|[1-9]\d*)$/u.test(trimmed)) {
    return Math.min(MAX_RETRY_AFTER_MS, Number(trimmed) * 1000);
  }

  if (!HTTP_DATE_PATTERN.test(trimmed)) {
    return undefined;
  }
  const dateEpochMs = Date.parse(trimmed);
  if (!Number.isFinite(dateEpochMs)) {
    return undefined;
  }
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, dateEpochMs - nowEpochMs));
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/** Dependencies used by the default Fetch-based aggregate transport. */
export interface DefaultSemanticJourneyTransportOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly baseUrl?: string;
  readonly now?: () => number;
}

/** Creates a Fetch transport with TLS enforcement and bounded retry metadata. */
export function createDefaultSemanticJourneyAggregateTransport(
  options: DefaultSemanticJourneyTransportOptions = {},
): SemanticJourneyAggregateTransport {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => Date.now());

  return async (request) => {
    if (!isSecureSemanticJourneyEndpoint(request.endpoint, options.baseUrl)) {
      throw new SemanticJourneyTransportError("rejected", false);
    }
    if (typeof fetchImplementation !== "function") {
      throw new SemanticJourneyTransportError("network_failure", true);
    }

    let resolvedEndpoint = request.endpoint;
    if (request.endpoint.startsWith("/")) {
      const base = resolveBaseUrl(options.baseUrl);
      if (!base) {
        throw new SemanticJourneyTransportError("rejected", false);
      }
      try {
        resolvedEndpoint = new URL(request.endpoint, base).toString();
      } catch {
        throw new SemanticJourneyTransportError("rejected", false);
      }
    }

    let response: Response;
    try {
      response = await fetchImplementation(resolvedEndpoint, {
        method: "POST",
        body: request.body,
        headers: request.headers,
        keepalive: request.keepalive ?? false,
        signal: request.signal,
        credentials: "omit",
        referrerPolicy: "no-referrer",
        redirect: "error",
      });
    } catch {
      if (request.signal.aborted) {
        throw new SemanticJourneyTransportError("aborted", true);
      }
      throw new SemanticJourneyTransportError("network_failure", true);
    }

    if (!response.ok) {
      throw new SemanticJourneyTransportError(
        "rejected",
        isRetryableStatus(response.status),
        response.status,
        parseRetryAfter(response.headers.get("retry-after"), now()),
      );
    }
  };
}

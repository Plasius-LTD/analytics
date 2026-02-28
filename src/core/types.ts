export type AnalyticsContext = Record<string, unknown>;
export type AnalyticsChannel = "frontend" | "backend";
export type AnalyticsRuntime = "browser" | "server";

export interface LocalSpaceAnalyticsEvent {
  component: string;
  action: string;
  channel?: AnalyticsChannel;
  label?: string;
  href?: string;
  variant?: string;
  requestId?: string;
  context?: AnalyticsContext;
  timestamp?: number;
}

export interface LocalSpaceAnalyticsRecord extends LocalSpaceAnalyticsEvent {
  id: string;
  timestamp: number;
  source: string;
  channel: AnalyticsChannel;
  runtime: AnalyticsRuntime;
  sessionId: string;
  context: AnalyticsContext;
}

export interface AnalyticsTransportRequest {
  endpoint: string;
  body: string;
  headers: Record<string, string>;
  keepalive: boolean;
}

export type AnalyticsTransport = (
  request: AnalyticsTransportRequest
) => Promise<void>;

export interface LocalSpaceAnalyticsConfig {
  endpoint?: string;
  source: string;
  channel?: AnalyticsChannel;
  runtime?: AnalyticsRuntime;
  sessionId?: string;
  injectChannelContext?: boolean;
  enabled?: boolean;
  defaultContext?: AnalyticsContext;
  headers?: Record<string, string>;
  flushIntervalMs?: number;
  batchSize?: number;
  maxQueueSize?: number;
  storageKey?: string;
  transport?: AnalyticsTransport;
  onError?: (error: unknown) => void;
}

export interface ResolvedLocalSpaceAnalyticsConfig {
  endpoint?: string;
  source: string;
  channel: AnalyticsChannel;
  runtime: AnalyticsRuntime;
  sessionId: string;
  injectChannelContext: boolean;
  enabled: boolean;
  defaultContext: AnalyticsContext;
  headers: Record<string, string>;
  flushIntervalMs: number;
  batchSize: number;
  maxQueueSize: number;
  storageKey: string;
  transport: AnalyticsTransport;
  onError?: (error: unknown) => void;
}

export interface LocalSpaceAnalyticsClient {
  readonly source: string;
  readonly channel: AnalyticsChannel;
  track: (event: LocalSpaceAnalyticsEvent) => void;
  trackFrontend: (
    event: Omit<LocalSpaceAnalyticsEvent, "channel">
  ) => void;
  trackBackend: (
    event: Omit<LocalSpaceAnalyticsEvent, "channel">
  ) => void;
  flush: () => Promise<void>;
  updateConfig: (config: Partial<LocalSpaceAnalyticsConfig>) => void;
  getConfig: () => Readonly<ResolvedLocalSpaceAnalyticsConfig>;
  destroy: () => void;
}

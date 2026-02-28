export type AnalyticsContext = Record<string, unknown>;

export interface LocalSpaceAnalyticsEvent {
  component: string;
  action: string;
  label?: string;
  href?: string;
  variant?: string;
  context?: AnalyticsContext;
  timestamp?: number;
}

export interface LocalSpaceAnalyticsRecord extends LocalSpaceAnalyticsEvent {
  id: string;
  timestamp: number;
  source: string;
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
  track: (event: LocalSpaceAnalyticsEvent) => void;
  flush: () => Promise<void>;
  updateConfig: (config: Partial<LocalSpaceAnalyticsConfig>) => void;
  getConfig: () => Readonly<ResolvedLocalSpaceAnalyticsConfig>;
  destroy: () => void;
}

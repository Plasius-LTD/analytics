export type AnalyticsContext = Record<string, unknown>;
export type AnalyticsChannel = "frontend" | "backend";
export type AnalyticsRuntime = "browser" | "server";
export type AnalyticsEventKind = "interaction" | "error";
export type AnalyticsErrorSeverity = "error" | "fatal";

export interface LocalSpaceAnalyticsErrorDetails {
  boundary: string;
  name: string;
  message: string;
  fingerprint: string;
  handled: boolean;
  severity: AnalyticsErrorSeverity;
  stack?: string;
  componentStack?: string;
  tags?: string[];
}

export interface LocalSpaceIssueReport {
  fingerprint: string;
  boundary: string;
  count: number;
  firstSeen: number;
  lastSeen: number;
  severity: AnalyticsErrorSeverity;
  sample: LocalSpaceAnalyticsErrorDetails;
}

export interface LocalSpaceIssueThresholdTrigger {
  source: string;
  channel: AnalyticsChannel;
  runtime: AnalyticsRuntime;
  thresholdCount: number;
  windowMs: number;
  report: LocalSpaceIssueReport;
}

export interface LocalSpaceErrorReportInput {
  boundary: string;
  error: unknown;
  componentStack?: string;
  handled?: boolean;
  severity?: AnalyticsErrorSeverity;
  tags?: string[];
  context?: AnalyticsContext;
  channel?: AnalyticsChannel;
  timestamp?: number;
}

export interface LocalSpaceErrorReportingConfig {
  enabled?: boolean;
  secureEndpointOnly?: boolean;
  maxMessageLength?: number;
  maxStackLength?: number;
  maxComponentStackLength?: number;
  maxContextDepth?: number;
  maxContextBreadth?: number;
  maxTagCount?: number;
  thresholdCount?: number;
  thresholdWindowMs?: number;
  redactKeys?: string[];
  onThresholdReached?: (event: LocalSpaceIssueThresholdTrigger) => void;
}

export interface ResolvedLocalSpaceErrorReportingConfig {
  enabled: boolean;
  secureEndpointOnly: boolean;
  maxMessageLength: number;
  maxStackLength: number;
  maxComponentStackLength: number;
  maxContextDepth: number;
  maxContextBreadth: number;
  maxTagCount: number;
  thresholdCount: number;
  thresholdWindowMs: number;
  redactKeys: string[];
  onThresholdReached?: (event: LocalSpaceIssueThresholdTrigger) => void;
}

export interface LocalSpaceAnalyticsEvent {
  component: string;
  action: string;
  kind?: AnalyticsEventKind;
  channel?: AnalyticsChannel;
  label?: string;
  href?: string;
  variant?: string;
  requestId?: string;
  context?: AnalyticsContext;
  error?: LocalSpaceAnalyticsErrorDetails;
  timestamp?: number;
}

export interface LocalSpaceAnalyticsRecord extends LocalSpaceAnalyticsEvent {
  id: string;
  kind: AnalyticsEventKind;
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
  errorReporting?: LocalSpaceErrorReportingConfig;
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
  errorReporting: ResolvedLocalSpaceErrorReportingConfig;
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
  reportError: (report: LocalSpaceErrorReportInput) => void;
  getIssueReports: () => ReadonlyArray<LocalSpaceIssueReport>;
  flush: () => Promise<void>;
  updateConfig: (config: Partial<LocalSpaceAnalyticsConfig>) => void;
  getConfig: () => Readonly<ResolvedLocalSpaceAnalyticsConfig>;
  destroy: () => void;
}

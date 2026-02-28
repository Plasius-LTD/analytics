import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import {
  createLocalSpaceAnalyticsClient,
  createNoopLocalSpaceAnalyticsClient,
} from "../core/client.js";
import type {
  LocalSpaceAnalyticsClient,
  LocalSpaceAnalyticsConfig,
  LocalSpaceAnalyticsEvent,
} from "../core/types.js";

export interface AnalyticsProviderProps {
  children: ReactNode;
  source?: string;
  endpoint?: string;
  enabled?: boolean;
  defaultContext?: LocalSpaceAnalyticsConfig["defaultContext"];
  headers?: LocalSpaceAnalyticsConfig["headers"];
  flushIntervalMs?: number;
  batchSize?: number;
  maxQueueSize?: number;
  storageKey?: string;
  transport?: LocalSpaceAnalyticsConfig["transport"];
  onError?: LocalSpaceAnalyticsConfig["onError"];
  client?: LocalSpaceAnalyticsClient;
}

export interface AnalyticsContextValue {
  client: LocalSpaceAnalyticsClient;
  trackInteraction: (event: LocalSpaceAnalyticsEvent) => void;
  flush: () => Promise<void>;
}

const AnalyticsContext = createContext<AnalyticsContextValue | null>(null);

export function AnalyticsProvider({
  children,
  source = "react-app",
  endpoint,
  enabled = true,
  defaultContext,
  headers,
  flushIntervalMs,
  batchSize,
  maxQueueSize,
  storageKey,
  transport,
  onError,
  client,
}: AnalyticsProviderProps) {
  const managedClient = useMemo(() => {
    if (client) {
      return client;
    }

    if (!enabled) {
      return createNoopLocalSpaceAnalyticsClient(source);
    }

    return createLocalSpaceAnalyticsClient({
      source,
      endpoint,
      enabled,
      defaultContext,
      headers,
      flushIntervalMs,
      batchSize,
      maxQueueSize,
      storageKey,
      transport,
      onError,
    });
  }, [
    client,
    source,
    endpoint,
    enabled,
    defaultContext,
    headers,
    flushIntervalMs,
    batchSize,
    maxQueueSize,
    storageKey,
    transport,
    onError,
  ]);

  useEffect(() => {
    return () => {
      if (!client) {
        managedClient.destroy();
      }
    };
  }, [client, managedClient]);

  const value = useMemo<AnalyticsContextValue>(
    () => ({
      client: managedClient,
      trackInteraction: (event: LocalSpaceAnalyticsEvent) => {
        managedClient.track(event);
      },
      flush: () => managedClient.flush(),
    }),
    [managedClient]
  );

  return <AnalyticsContext.Provider value={value}>{children}</AnalyticsContext.Provider>;
}

export function useAnalytics(): AnalyticsContextValue {
  const context = useContext(AnalyticsContext);

  if (!context) {
    throw new Error("useAnalytics must be used within AnalyticsProvider.");
  }

  return context;
}

import { useCallback } from "react";
import type { AnalyticsContext, LocalSpaceAnalyticsEvent } from "../core/types.js";
import { useAnalytics } from "./provider.js";

export interface TrackInteractionDetails
  extends Omit<LocalSpaceAnalyticsEvent, "component" | "action" | "context"> {
  context?: AnalyticsContext;
}

export function useComponentInteractionTracker(
  component: string,
  baseContext: AnalyticsContext = {}
): (action: string, details?: TrackInteractionDetails) => void {
  const { trackInteraction } = useAnalytics();

  return useCallback(
    (action: string, details?: TrackInteractionDetails) => {
      trackInteraction({
        component,
        action,
        label: details?.label,
        href: details?.href,
        variant: details?.variant,
        timestamp: details?.timestamp,
        context: {
          ...baseContext,
          ...(details?.context ?? {}),
        },
      });
    },
    [baseContext, component, trackInteraction]
  );
}

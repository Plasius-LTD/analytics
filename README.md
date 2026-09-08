# @plasius/analytics

[![npm version](https://img.shields.io/npm/v/@plasius/analytics.svg)](https://www.npmjs.com/package/@plasius/analytics)
[![Build Status](https://img.shields.io/github/actions/workflow/status/Plasius-LTD/analytics/ci.yml?branch=main&label=build&style=flat)](https://github.com/Plasius-LTD/analytics/actions/workflows/ci.yml)
[![coverage](https://img.shields.io/codecov/c/github/Plasius-LTD/analytics)](https://codecov.io/gh/Plasius-LTD/analytics)
[![License](https://img.shields.io/github/license/Plasius-LTD/analytics)](./LICENSE)
[![Code of Conduct](https://img.shields.io/badge/code%20of%20conduct-yes-blue.svg)](./CODE_OF_CONDUCT.md)
[![Security Policy](https://img.shields.io/badge/security%20policy-yes-orange.svg)](./SECURITY.md)
[![Changelog](https://img.shields.io/badge/changelog-md-blue.svg)](./CHANGELOG.md)

Local-space analytics primitives for browser apps and reusable React components.

## Features

- Queue interaction events locally (in-memory + `localStorage` backup)
- Flush analytics batches to a configurable endpoint
- Support frontend and backend analytics channels simultaneously
- Report crash/error-boundary events with structured payloads
- Sanitize error reports to reduce accidental PII leakage
- Trigger threshold callbacks for automated remediation workflows
- Browser-lifecycle flush support (`visibilitychange`, `pagehide`, `sendBeacon`)
- React provider and hooks for component-level event instrumentation
- Local-private semantic journeys that join frontend intent to backend consequence
- Aggregate-only adaptive batching with bounded queues, retries, and idempotency
- Deterministic replay-style inference with explicit causal gaps and uncertainty

## Install

```bash
npm install @plasius/analytics
```

## Legacy Core API

The API below is a compatibility surface, not the privacy-safe event NFR path.
New integrations should use the opt-in semantic client and approved aggregate
contract below. The Plasius site is retiring unrestricted legacy ingestion;
do not forward these legacy records to the semantic endpoint.

```ts
import {
  createBackendAnalyticsClient,
  createFrontendAnalyticsClient,
} from "@plasius/analytics";

const frontendAnalytics = createFrontendAnalyticsClient({
  source: "sharedcomponents",
  endpoint: "https://analytics.example.com/collect",
  defaultContext: {
    application: "white-label-portal",
  },
});

const backendAnalytics = createBackendAnalyticsClient({
  source: "plasius-ltd-site-api",
  endpoint: "https://analytics.example.com/collect",
});

frontendAnalytics.track({
  component: "Header",
  action: "nav_click",
  label: "About",
  href: "/about",
  context: {
    surface: "desktop",
  },
});

backendAnalytics.track({
  component: "VideoWorker",
  action: "job_completed",
  requestId: "req-123",
  context: { worker: "render" },
});

await frontendAnalytics.flush();
await backendAnalytics.flush();
```

## Local-Private Semantic Journeys

Semantic journeys are an additive v2 API. The individual story remains in bounded, memory-only client state; `flush()` sends only coarse event-name/outcome counters. Aggregate payloads contain no journey, trace, event, producer, session, device, IP-derived, or user identifier.

### Reviewed aggregate views (2.1)

For screen/action or world/metric breakdowns, explicitly opt in to catalogue-owned
projections. An ordinary event attribute is **not** automatically uploaded:

```ts
import {
  defineSemanticJourneyCatalog,
  defineSemanticJourneyAggregatePolicy,
  createSemanticJourneyAggregateValidator,
  createSemanticJourneyClient,
} from "@plasius/analytics";

const catalogue = defineSemanticJourneyCatalog({
  "ui.control.activate": {
    category: "interaction",
    attributes: {
      screen: { type: "enum", values: ["home", "generator"] },
      action: { type: "enum", values: ["select", "retry"] },
    },
  },
}, { sources: ["plasius.site"] });
const aggregatePolicy = defineSemanticJourneyAggregatePolicy(catalogue, {
  bindings: [{ source: "plasius.site", channel: "frontend", runtime: "browser" }],
  projections: {
    "ui.control.activate": { "screen-action": ["screen", "action"] },
  },
});
declare const analyticsConsentAndRemotePermission: boolean;
const client = createSemanticJourneyClient({
  catalogue, aggregatePolicy, source: "plasius.site", channel: "frontend", runtime: "browser",
  enabled: analyticsConsentAndRemotePermission,
  aggregateEndpoint: "/api/analytics/semantic-aggregates",
});
client.track({ name: "ui.control.activate", category: "interaction", phase: "intent",
  outcome: "success", attributes: { screen: "home", action: "select" } });

// Receiving hosts compile the same policy, then validate a bounded JSON body.
const validateAggregate = createSemanticJourneyAggregateValidator(aggregatePolicy);
// On consent withdrawal: client.destroy(); (discard, cancel; no flush).
```

Each 2.1 counter contains a `view` and its exact registered enum `dimensions`.
The independent `total` view has no dimensions. Never sum across views. Missing
optional attributes omit their view; unknown fields/values reject the event.
Numeric/boolean attributes, private context, targets and causal IDs are not
projectable. Hosts must review the meaning of their finite tokens; grammar is
not an anonymity guarantee.

Policies allow at most 128 exact producer bindings, eight views per event, four
enum dimensions per view and 4,096 value combinations per view. The generated
validator rejects duplicate counter keys, unsafe counts, unknown fields and
payloads above 500 rows/64 KiB; bound HTTP reads before parsing as well.

The shared client keeps one retry snapshot and original observation hours, with
projected rows bounded by its queue count/byte/age settings (default 1,000 rows,
1 MiB, 30 minutes). To preserve consistency, expiry discards the whole pending
hour when its oldest row expires, potentially discarding newer observations in
that hour. Drops are reported, not silently retained. Projected clients default
to two 48-KiB batches per 60-second flush, two retries and five-second deadlines.
No policy means unchanged strict 2.0 output. The validator explicitly supports
strict 2.0 input; it does not accept unrestricted legacy event packets.

Hosts own consent and remote controls, storage/retention, deduplication,
processing and low-volume report suppression. Shipping this SDK enables none of
those production behaviours. See [projection design](docs/design/aggregate-projections.md).

### Local causal capture and receipts

The client defaults to disabled. Hosts must pass the remotely resolved `platform.analytics.semantic-journeys.enabled` decision:

```ts
import {
  SEMANTIC_JOURNEY_RECEIPT_HEADER,
  createSemanticJourneyClient,
  defineSemanticJourneyCatalog,
} from "@plasius/analytics";

const catalogue = defineSemanticJourneyCatalog({
  "checkout.submit": { category: "interaction" },
  "checkout.create": { category: "request" },
  "order.create": {
    category: "command",
    effects: ["policy-denied"],
  },
}, { sources: ["site"] });

declare const semanticJourneysEnabled: boolean;

const journeys = createSemanticJourneyClient({
  catalogue,
  source: "site",
  channel: "frontend",
  runtime: "browser",
  enabled: semanticJourneysEnabled,
  aggregateEndpoint: "/api/analytics/semantic-aggregates",
});

const intent = journeys.track({
  name: "checkout.submit",
  category: "interaction",
  phase: "intent",
  outcome: "unknown",
  modality: "keyboard",
});

const request = journeys.beginRequest(
  {
    name: "checkout.create",
    category: "request",
    phase: "start",
    outcome: "unknown",
  },
  { causedByEventId: intent?.eventId },
);

if (request) {
  const response = await fetch("/api/orders", {
    method: "POST",
    headers: { traceparent: request.traceparent },
  });
  request.complete(response.headers.get(SEMANTIC_JOURNEY_RECEIPT_HEADER));
}

const replay = journeys.reconstruct();
await journeys.flush();
```

Backends produce bounded, catalogue-validated consequence receipts with `serializeSemanticJourneyReceipts`. Each outbound request gets a fresh `traceparent`; neither the private journey ID nor an episode-wide trace crosses the boundary. Browser-wide semantic coverage is available through `observeSemanticJourneyInteractions`, which requires an explicit `enabled: true` rollout decision and observes only registered `data-plasius-event`, `data-plasius-target-type`, and `data-plasius-target-id` annotations without reading DOM text, form values, URLs, keys, pointer coordinates, or arbitrary attributes.

Catalogue names, sources, targets, effects, and enum values must be reviewed developer-owned semantic classes, never application/entity identifiers or user-provided content. Sources are admitted by the catalogue-wide allowlist; targets and backend effects are admitted by per-event allowlists. The privacy policy version is the package-owned `strict.v1` constant and is not caller-configurable. Unknown or unregistered fields reject the whole event without echoing rejected values. Aggregate Fetch transport omits credentials and referrers and rejects redirects. Uploaded individual journeys are intentionally not supported by this local-private client; any future controlled-server replay mode must be separately gated and governed as pseudonymous Personal Data.

Aggregate transport accepts RFC 9110 `Retry-After` integer delay-seconds and
HTTP dates, capped at five minutes; malformed numeric forms are ignored.
Runtime rollout inherits `governance.rfc-compliance-remediation.enabled`, with
the disabled state retaining the prior transport only during migration.

## Crash Reporting

```ts
import { createFrontendAnalyticsClient } from "@plasius/analytics";

const analytics = createFrontendAnalyticsClient({
  source: "sharedcomponents",
  endpoint: "https://analytics.example.com/collect",
  errorReporting: {
    thresholdCount: 5,
    thresholdWindowMs: 300000,
    onThresholdReached: ({ report }) => {
      // Hook into your automation system (ticket/task/alert)
      console.log("error threshold reached", report.fingerprint, report.count);
    },
  },
});

analytics.reportError({
  boundary: "CheckoutBoundary",
  error: new Error("Payment failed"),
  context: {
    feature: "checkout",
    ipAddress: "198.51.100.10",
    sessionToken: "opaque-session-token",
  },
});

const issueReports = analytics.getIssueReports();
```

Error reporting is secure-by-default. When `secureEndpointOnly` is enabled (default), crash reports are sent only to `https` endpoints (or localhost for development).
PII/private-data handling for crash payloads is delegated to `@plasius/schema` as the source of truth:
- crash context is normalized, sensitive keys are identified, and a machine/session identity envelope is built.
- the identity envelope is passed through schema `prepareForStorage`, which applies field-level hashing/redaction policies before transport.
- non-sensitive diagnostics remain available as mixed typed fields for debugging.

## React API

```tsx
import {
  AnalyticsProvider,
  useComponentInteractionTracker,
} from "@plasius/analytics";

function SaveButton() {
  const track = useComponentInteractionTracker("SaveButton", {
    feature: "document-editor",
  });

  return (
    <button
      type="button"
      onClick={() => track("click", { label: "Save" })}
    >
      Save
    </button>
  );
}

<AnalyticsProvider
  source="sharedcomponents"
  endpoint="https://analytics.example.com/collect"
  channel="frontend"
>
  <SaveButton />
</AnalyticsProvider>;
```

## Payload Shape

`POST` body:

```json
{
  "source": "sharedcomponents",
  "channel": "frontend",
  "runtime": "browser",
  "sentAt": 1735300000000,
  "events": [
    {
      "id": "event_xxx",
      "source": "sharedcomponents",
      "channel": "frontend",
      "runtime": "browser",
      "sessionId": "session_xxx",
      "timestamp": 1735300000000,
      "kind": "error",
      "component": "Header",
      "action": "error_boundary_caught",
      "label": "err_abc123",
      "error": {
        "boundary": "CheckoutBoundary",
        "name": "Error",
        "message": "Payment failed",
        "fingerprint": "err_abc123",
        "handled": true,
        "severity": "error"
      },
      "context": {
        "analyticsChannel": "frontend",
        "analyticsRuntime": "browser",
        "feature": "checkout",
        "errorFingerprint": "err_abc123",
        "errorBoundary": "CheckoutBoundary",
        "errorSeverity": "error",
        "errorHandled": true
      }
    }
  ]
}
```

## Privacy-safe useful metrics

Lazy collectors should import `projectUsefulMetric` and
`USEFUL_METRIC_EVENT_DEFINITIONS` from `@plasius/analytics/metrics`. This standalone
ESM/CJS entry contains no React, collectors or transport. Existing root exports
remain compatible, but using the focused entry lets a bundler keep optional
metric code out of a host's initial analytics graph, including when that host
loads the metric entry dynamically. The published entries are independent bundles
from one source, avoiding an eager shared metric chunk. The host must
still verify its real application bundle and own flag evaluation and transport.

Compose the fixed definitions into the host's semantic catalogue, then project
one observation before tracking it with the existing bounded client:

```ts
import {
  USEFUL_METRIC_EVENT_DEFINITIONS,
  defineSemanticJourneyCatalog,
  projectUsefulMetric,
} from "@plasius/analytics";

const catalogue = defineSemanticJourneyCatalog(
  USEFUL_METRIC_EVENT_DEFINITIONS,
  { sources: ["plasius.site"] },
);
const event = projectUsefulMetric({ metric: "page.load", value: 1250 });
// Configure your host client with catalogue; if enabled and event !== null,
// call client.track(event). No direct send or flush is needed per observation.
```

Duration keys (milliseconds): `page.load`, `route.ready`, `world.ready`,
`request.duration`, `vital.lcp`, `vital.fcp`, `vital.inp`, `vital.ttfb` and
`episode.active-duration`. `vital.cls` accepts a unitless layout-shift score.
Durations must be finite, non-negative and <=24 hours; CLS must be <=100.

Counters accept only `{ metric }`: `episode.started`, `episode.completed`,
`request.started`, `request.completed`, `request.failed`, `request.cancelled`,
`request.rejected`, `error.runtime`, `error.resource`, `error.render`, and
`error.unhandled`. All other fields/names, accessors and invalid measurements
return `null`, including legacy NFR objects containing URL/DOM/error metadata.

There are 84 fixed catalogue entries. Numeric values become bounded event-name
buckets, not attributes or raw measurements, so histograms survive the existing
aggregate format. General durations use upper-exclusive boundaries at 100, 250,
500, 1000, 2500, 5000 and 10000 ms; active episodes at 10, 60, 300, 900 and 3600
seconds; CLS at 0.1 and 0.25. Final buckets include all remaining valid values.

The host must evaluate its remote rollout flag, cap observation frequency,
dispose collectors/client on rollback, and emit only one final web-vital
observation per measurement period. Episode counts are in-memory activity
periods, not unique users or cross-tab sessions: exclude hidden time and disclose
reload/tab duplication and lost final observations. No identifiers or persistence
are needed. Metric error categories never accept an Error object or message.

The service must approve the same fixed definitions and process these counters
before useful metric delivery can be claimed. This helper installs no collectors
or transport and does not certify legacy analytics payloads as privacy-safe.

## Development

```bash
npm install
npm run typecheck
npm run build
npm test
npm run test:coverage
```

## Public Artifact Integrity

CI rejects the administrative contributor-registry path from both the exact Git
index and the npm dry-run inventory without reading its contents. CI runs on the
approved self-hosted runner group. Package publication uses Node 24.18.0 LTS and
npm OIDC trusted publishing through the GitHub-hosted `production` CD job only;
do not publish locally or configure a long-lived npm token. CD publishes only
while its prepared commit remains the exact `main` head, after successful
push-triggered CI for that SHA, and on Node 24 with npm 11.5.1 or newer.

## Governance

- ADRs: [docs/adrs](./docs/adrs)
- Semantic journey design: [docs/design/privacy-safe-causal-journeys.md](./docs/design/privacy-safe-causal-journeys.md)
- Security policy: [SECURITY.md](./SECURITY.md)
- Legal docs: [legal](./legal)

## License

Apache-2.0

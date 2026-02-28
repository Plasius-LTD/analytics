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
- Browser-lifecycle flush support (`visibilitychange`, `pagehide`, `sendBeacon`)
- React provider and hooks for component-level event instrumentation

## Install

```bash
npm install @plasius/analytics
```

## Core API

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
      "component": "Header",
      "action": "nav_click",
      "requestId": "req-123",
      "label": "About",
      "href": "/about",
      "variant": "desktop",
      "context": {
        "analyticsChannel": "frontend",
        "analyticsRuntime": "browser",
        "application": "white-label-portal",
        "feature": "navigation"
      }
    }
  ]
}
```

## Development

```bash
npm install
npm run build
npm test
npm run test:coverage
```

## Governance

- ADRs: [docs/adrs](./docs/adrs)
- Security policy: [SECURITY.md](./SECURITY.md)
- Legal docs: [legal](./legal)

## License

Apache-2.0

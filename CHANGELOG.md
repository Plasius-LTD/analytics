# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

- **Added**
  - (placeholder)

- **Changed**
  - (placeholder)

- **Fixed**
  - (placeholder)

- **Security**
  - (placeholder)

## [1.2.4] - 2026-08-31

- **Added**
  - (placeholder)

- **Changed**
  - Raised the runtime `@plasius/schema` baseline to `^1.4.3` and refreshed the compatible development toolchain.

- **Fixed**
  - Kept release-branch validation on hosted runners while reserving the
    self-hosted pool for the exact `main` ref.
  - (placeholder)

- **Security**
  - (placeholder)

## [1.2.3] - 2026-08-30

- **Added**
  - (placeholder)

- **Changed**
  - Standardized CI and trusted npm publication on Node 24.18.0 LTS.
  - Bound publication to the prepared commit only while it remains the exact `main` head and has successful push-triggered CI.
  - Refreshed transitive dependency resolutions to clear the current high-severity npm audit findings.

- **Fixed**
  - (placeholder)

- **Security**
  - Added exact Git-index and npm-package inventory gates that reject the administrative contributor-registry path without reading it, and removed that path from the current source tip.
  - Removed the legacy npm write-token path and added a fail-closed Node 24 and npm 11.5.1-or-newer publication guard.
  - Restricted public self-hosted CI to pushes on repository-owned branches, preventing fork PR code from executing on self-hosted runners.

## [1.2.2] - 2026-07-13

- **Added**
  - (placeholder)

- **Changed**
  - (placeholder)
  - Consume the RFC-remediated `@plasius/schema` release (task #34).

- **Fixed**
  - (placeholder)

- **Security**
  - (placeholder)

## [1.2.1] - 2026-07-12

- **Added**
  - (placeholder)

- **Changed**
  - (placeholder)

- **Fixed**
  - Parse RFC 9110 `Retry-After` delay-seconds as integers only while retaining
    HTTP-date support and the existing five-minute retry cap.

- **Security**
  - (placeholder)

## [1.2.0] - 2026-07-12

- **Added**
  - Added an opt-in v2 semantic journey contract with strict catalogues, cryptographically random causal contexts, W3C `traceparent` propagation, bounded consequence receipts, deterministic local replay, and explicit evidence-gap reporting.
  - Added delegated browser semantic interaction observation for explicit developer annotations without inspecting DOM content, values, URLs, keys, or coordinates.
  - Added memory-only local journey queues and aggregate-only batching with count/byte limits, coalescing, idle rotation, idempotency keys, timeouts, cancellation, and bounded retry.

- **Changed**
  - Documented the architectural boundary between default local-private journeys and any future controlled-server replay governed as pseudonymous Personal Data.

- **Fixed**
  - (placeholder)

- **Security**
  - Semantic input now has a fail-closed, non-echoing validation path that rejects unknown fields, unregistered attributes, unbounded values, and sensitive-looking content.
  - Aggregate transport deliberately excludes journey, trace, event, producer, session, device, IP-derived, and user identifiers.
  - Sources, targets, and consequence effects require immutable catalogue allowlists, and the privacy policy version is package-owned; aggregate Fetch requests omit credentials and referrers, reject redirects, and retain idempotency keys across ambiguous failures.
  - Overrode the development toolchain to patched `esbuild` `^0.28.1` to remediate GHSA-g7r4-m6w7-qqqr.

## [1.1.17] - 2026-06-28

- **Added**
  - (placeholder)

- **Changed**
  - Refreshed `@plasius/schema` to `^1.2.17` and updated development dependency baselines to `@types/node@26.0.1`, `@typescript-eslint/*@8.62.0`, `eslint@10.6.0`, `globals@17.7.0`, and `vitest@4.1.9`.

- **Fixed**
  - (placeholder)

- **Security**
  - (placeholder)

## [1.1.16] - 2026-06-22

- **Added**
  - (placeholder)

- **Changed**
  - (placeholder)

- **Fixed**
  - (placeholder)

- **Security**
  - (placeholder)

## [1.1.15] - 2026-06-22

- **Added**
  - (placeholder)

- **Changed**
  - (placeholder)

- **Fixed**
  - (placeholder)

- **Security**
  - (placeholder)

## [1.1.12] - 2026-06-01

- **Added**
  - (placeholder)

- **Changed**
  - Added a canonical `npm run typecheck` gate and wired repository automation to reuse it for explicit TypeScript validation.

- **Fixed**
  - (placeholder)

- **Security**
  - (placeholder)

## [1.1.11] - 2026-05-13

- **Added**
  - (placeholder)

- **Changed**
  - Refreshed dependencies to the latest stable published versions.
  - (placeholder)

- **Fixed**
  - (placeholder)

- **Security**
  - (placeholder)

## [1.1.10] - 2026-05-13

- **Added**
  - (placeholder)

- **Changed**
  - (placeholder)

- **Fixed**
  - (placeholder)

- **Security**
  - (placeholder)

## [1.1.9] - 2026-04-21

- **Added**
  - (placeholder)

- **Changed**
  - (placeholder)

- **Fixed**
  - (placeholder)

- **Security**
  - (placeholder)

## [1.1.8] - 2026-04-21

- **Added**
  - (placeholder)

- **Changed**
  - (placeholder)

- **Fixed**
  - (placeholder)

- **Security**
  - (placeholder)

## [1.1.7] - 2026-04-02

- **Added**
  - (placeholder)

- **Changed**
  - (placeholder)

- **Fixed**
  - (placeholder)

- **Security**
  - (placeholder)

## [1.1.6] - 2026-03-09

- **Added**
  - (placeholder)

- **Changed**
  - (placeholder)

- **Fixed**
  - Stopped forcing `fetch(..., { keepalive: true })` on normal flushes so browser analytics POSTs do not remain pending behind proxies while unload delivery continues to use `sendBeacon`.

- **Security**
  - (placeholder)

## [1.1.5] - 2026-03-09

- **Added**
  - (placeholder)

- **Changed**
  - Raised the minimum `@plasius/schema` dependency to `^1.2.6` to consume field exposure metadata and safe serialization support.

- **Fixed**
  - (placeholder)

- **Security**
  - (placeholder)

## [1.1.4] - 2026-03-04

- **Added**
  - `reportError` and `getIssueReports` on analytics clients for structured crash/error-boundary reporting.
  - Error issue-threshold callbacks (`errorReporting.onThresholdReached`) to support automated remediation workflows.

- **Changed**
  - Extended event payloads with `kind` and optional structured `error` metadata for crash diagnostics.
  - Error-report sanitization now reuses `@plasius/schema` as the source of truth for private-data handling, including `prepareForStorage` transforms for crash identity fields.

- **Fixed**
  - Normalized persisted legacy events to include explicit event kind defaults.
  - Hardened error-context sanitization to handle circular structures without crashing reporters.

- **Security**
  - Added redaction and context sanitization for error-report payloads.
  - Enforced secure-by-default endpoint checks for crash reporting (`https`/localhost unless explicitly overridden).

## [1.1.0] - 2026-02-28

### Added

- Dual-channel analytics support for simultaneous frontend and backend event capture.
- Channel-specific client helpers: `createFrontendAnalyticsClient` and `createBackendAnalyticsClient`.
- Channel/runtime metadata on queued events and payload batches to simplify shared offline blob processing.
- New tests covering mixed-channel payloads, channel-aware queue keys, and backend client defaults.

### Fixed

- Declared `@testing-library/dom` as a direct dev dependency so clean Node 24 CI coverage runs resolve React testing imports reliably.

## [1.0.0] - 2026-02-28

### Added

- Initial release of `@plasius/analytics`.
- Local-space analytics client with queueing, browser lifecycle flush hooks, `sendBeacon` support, and configurable transport.
- React integration with `AnalyticsProvider`, `useAnalytics`, and `useComponentInteractionTracker`.
- Unit tests for transport/queue behavior and React provider/hook integration.
[1.1.0]: https://github.com/Plasius-LTD/analytics/releases/tag/v1.1.0
[1.1.4]: https://github.com/Plasius-LTD/analytics/releases/tag/v1.1.4
[1.1.5]: https://github.com/Plasius-LTD/analytics/releases/tag/v1.1.5
[1.1.6]: https://github.com/Plasius-LTD/analytics/releases/tag/v1.1.6
[1.1.7]: https://github.com/Plasius-LTD/analytics/releases/tag/v1.1.7
[1.1.8]: https://github.com/Plasius-LTD/analytics/releases/tag/v1.1.8
[1.1.9]: https://github.com/Plasius-LTD/analytics/releases/tag/v1.1.9
[1.1.10]: https://github.com/Plasius-LTD/analytics/releases/tag/v1.1.10
[1.1.11]: https://github.com/Plasius-LTD/analytics/releases/tag/v1.1.11
[1.1.12]: https://github.com/Plasius-LTD/analytics/releases/tag/v1.1.12
[1.1.15]: https://github.com/Plasius-LTD/analytics/releases/tag/v1.1.15
[1.1.16]: https://github.com/Plasius-LTD/analytics/releases/tag/v1.1.16
[1.1.17]: https://github.com/Plasius-LTD/analytics/releases/tag/v1.1.17
[1.2.0]: https://github.com/Plasius-LTD/analytics/releases/tag/v1.2.0
[1.2.1]: https://github.com/Plasius-LTD/analytics/releases/tag/v1.2.1
[1.2.2]: https://github.com/Plasius-LTD/analytics/releases/tag/v1.2.2
[1.2.3]: https://github.com/Plasius-LTD/analytics/releases/tag/v1.2.3
[1.2.4]: https://github.com/Plasius-LTD/analytics/releases/tag/v1.2.4

# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

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

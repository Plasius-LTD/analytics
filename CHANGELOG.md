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

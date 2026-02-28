# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Added

- Dual-channel analytics support for simultaneous frontend and backend event capture.
- Channel-specific client helpers: `createFrontendAnalyticsClient` and `createBackendAnalyticsClient`.
- Channel/runtime metadata on queued events and payload batches to simplify shared offline blob processing.
- New tests covering mixed-channel payloads, channel-aware queue keys, and backend client defaults.

## [1.0.0] - 2026-02-28

### Added

- Initial release of `@plasius/analytics`.
- Local-space analytics client with queueing, browser lifecycle flush hooks, `sendBeacon` support, and configurable transport.
- React integration with `AnalyticsProvider`, `useAnalytics`, and `useComponentInteractionTracker`.
- Unit tests for transport/queue behavior and React provider/hook integration.

# ADR-0001: Analytics Package Scope and Local-Space Event Pipeline

- Status: Accepted
- Date: 2026-02-28

## Context

`@plasius/sharedcomponents` needs consistent interaction logging across reusable React components. Endpoint routing is white-label driven, so the package must support runtime endpoint configuration and tolerate disconnected states.

## Decision

Create `@plasius/analytics` as a small runtime package that provides:

- A local-space analytics client (`createLocalSpaceAnalyticsClient`) with queueing and endpoint flush.
- Optional persistence via `localStorage` to survive route/page transitions.
- Browser lifecycle flush behavior (`visibilitychange`, `pagehide`, `sendBeacon`) to reduce event loss.
- React integration (`AnalyticsProvider`, hooks) so components can track interactions without app-specific analytics SDK coupling.

## Consequences

- Shared components can emit structured interaction logs through one package contract.
- White-label apps can inject endpoint metadata without coupling sharedcomponents to any one analytics vendor.
- Hosts can override transport for testing or for custom ingestion implementations.

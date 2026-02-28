# ADR-0002: Dual ESM and CJS Distribution

- Status: Accepted
- Date: 2026-02-28

## Context

Consumers of `@plasius/analytics` include Vite/browser ESM apps and Node-based tooling/test environments that still resolve CJS.

## Decision

Build with `tsup` to publish both ESM and CJS outputs from a single TypeScript source tree.

## Consequences

- Integrations remain compatible across modern frontend bundlers and Node runtimes.
- Package exports remain explicit and typed (`types`, `import`, `require`).

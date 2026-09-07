# ADR 0006: Standalone useful metric entry

## Status

Accepted for Task #49.

## Context

A single root bundle can pull optional metric projection into initial host
analytics imports. Load-time budgets apply to observability too; an application
must not raise its budget or hide measured assets to adopt useful metrics.

## Decision

Publish `@plasius/analytics/metrics` as a separate ESM/CJS entry with declarations.
Keep root exports compatible. Both entry points derive from the same source;
shared chunks avoid duplicated implementations. Mark only fixed, literal metric
initialization as pure so bundlers can remove an unused optional projection.
No host callbacks, validation, transport or runtime work is marked pure.

Collectors should import the focused entry. Root exports remain supported, but
cannot promise lazy behavior for consumers that import all features through one
module. Host bundle validation remains mandatory.

## Validation

Test published ESM/CJS resolution and identical output, no metric initialization
in a legacy-only bundle, and a bounded standalone bundle without React, listeners
or network code. Existing strict privacy projection and journey tests remain.

# ADR 0006: Standalone useful metric entry

## Status

Accepted for Task #49.

## Context

A single root bundle can pull optional metric projection into initial host
analytics imports. Load-time budgets apply to observability too; an application
must not raise its budget or hide measured assets to adopt useful metrics.

## Decision

Publish `@plasius/analytics/metrics` as a separate ESM/CJS entry with declarations.
Keep root exports compatible. Both entry points derive from the same source,
but publish independent bundles rather than a shared runtime chunk. A shared
chunk is statically reachable from the root even when a host only needs its
metrics through a dynamic import, causing downstream bundlers to load them early.
The small projection can be duplicated when both entries are consumed; this
trade-off preserves the optional loading boundary without maintaining two source
implementations. Mark only fixed, literal metric
initialization as pure so bundlers can remove an unused optional projection.
No host callbacks, validation, transport or runtime work is marked pure.

Collectors should import the focused entry. Root exports remain supported, but
cannot promise lazy behavior for consumers that import all features through one
module. Host bundle validation remains mandatory.

## Validation

Test published ESM/CJS resolution and identical output, no metric initialization
in a legacy-only bundle, no metrics in the complete static dependency graph of a
legacy host with a dynamic metric import, and a bounded standalone bundle without
React, listeners or network code. Assert the deferred graph still contains metrics.
Existing strict privacy projection and journey tests remain.

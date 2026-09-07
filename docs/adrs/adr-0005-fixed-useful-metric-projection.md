# ADR 0005: Fixed useful metric projection

## Status

Accepted for implementation; package release and consuming-service rollout are
separate gates. Tracked by analytics#46 under site Story #2160, Feature #1464,
Epic #1463.

## Context

NFR collectors may produce raw URL, DOM, timing and error metadata that must not
cross the local-private boundary. The semantic aggregate format intentionally
retains only event name, outcome and count; attributes do not survive transport.
Adding a duration attribute therefore cannot produce a useful service histogram.

## Decision

Provide a pure fail-closed projection with 84 immutable event definitions. Fixed
metric keys map finite numeric observations into fixed bucket names before local
tracking or serialization. Count observations accept no numeric amount. Reject
extra fields, accessors, non-finite/negative/out-of-range measurements and unknown
keys without logging or reflecting input. No runtime dependency is added.

Compose these definitions into the host catalogue and collector allowlist. Reuse
the existing bounded semantic client/transport; do not create a parallel sender
or widen the aggregate schema to arbitrary dimensions. Existing clients remain
compatible. Duration observations have outcome `unknown`; request outcome counts
are independent observations and must not be inferred from a timing sample.

An episode is an in-memory activity period, not an identifiable session. The
host emits one start, completion and active-duration observation when available;
it must exclude hidden time and document losses/reloads/multiple tabs. No episode
or session identifier is accepted or exported.

## Rollout and consequences

The host owns stored remote flag `platform.analytics.semantic-journeys.enabled`,
default disabled, listener lifecycle, sampling and observation-rate limits. This
pure helper cannot read a remote flag or install collectors. Rollback destroys
the host client/collectors and discards unsent observations. No capability is
needed for the helper; existing 3D controls still apply to world producers.

Collectors must project explicitly selected numeric fields and fixed categories,
never pass legacy NFR objects straight through. Service adoption and processing
tests are required before claiming delivery. Metric counts are sampled
observations, not unique people; an outcome counter is only meaningful with its
documented denominator. Fixed bucket definitions are versioned API semantics.

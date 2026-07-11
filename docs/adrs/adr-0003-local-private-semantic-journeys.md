# ADR-0003: Local-Private Semantic Journeys

- Status: Accepted
- Date: 2026-07-11

## Context

The legacy analytics contract accepts arbitrary context and linkable session data. It can count isolated interactions, but it cannot safely explain causal frontend and backend consequences or support deterministic replay-style inference.

A detailed behavioural sequence may identify or become linkable to a person even when direct identifiers are removed. Random and hashed identifiers do not make an uploaded journey anonymous. The platform also needs to batch efficiently rather than POST after each interaction.

## Decision

Add an independent, additive semantic journey contract to `@plasius/analytics` with two explicitly separate privacy modes.

Local-private mode is the default. It keeps individual events and causal identifiers in bounded, memory-only client state. Only a fresh W3C-compatible request trace crosses each same-origin request boundary, allowing a backend to return catalogue-controlled consequence receipts without exposing an episode-wide trace. The client uploads only coarse counters that contain no journey, trace, event, producer, session, device, IP-derived, or user identifier.

Controlled-server replay is a future, separately gated mode. Any uploaded individual journey is governed as pseudonymous Personal Data and requires a DPIA, lawful basis or consent, short retention, erasure/export support, encryption, audited access, and an authorised viewer. It must not be described as anonymous.

Semantic inputs are admitted through a bounded catalogue. Sources, targets, effects, and enum values require reviewed immutable allowlists, while the privacy policy version is package-owned and cannot carry caller data. Unknown fields, unregistered attributes, malformed tokens, and sensitive-looking content fail closed. Browser automation reads only explicit semantic annotations; it never reads DOM text, field values, URLs, selectors, request bodies, or response bodies.

Cryptographically random causal identifiers and a fresh W3C `traceparent` per outbound request provide ordering evidence without exposing an episode-wide trace. Producer sequences, parent spans, and caused-by links take precedence over timestamps. Reconstruction exposes gaps and invalid evidence rather than inventing certainty.

Aggregate transport uses reviewed source/event allowlists, bounded count and byte batches, a single in-flight flush, stable idempotency across ambiguous failures, credentialless/referrerless Fetch requests, timeouts, cancellation, and bounded retry with jitter. The primary remote flag is `platform.analytics.semantic-journeys.enabled`; `platform.analytics.semantic-journeys.server-replay.enabled` independently protects the controlled-server path. Both default to disabled.

## Consequences

- The default replay story can join frontend intent with backend consequence without uploading the individual story.
- Service traffic is reduced to periodic aggregate batches instead of per-interaction requests.
- Aggregate collectors must avoid retaining request identity metadata and must apply short retention and low-cardinality query controls.
- Legacy v1 analytics remains compatible but is outside the local-private privacy claim and needs a governed migration.
- A future server replay viewer requires the `admin.analytics.semantic-journey-replay.view` capability as well as its rollout flag and normal authorisation.
- `@plasius/graph-events` remains responsible for graph-cache invalidation and projections; it does not become an analytics journey store.

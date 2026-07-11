# Privacy-Safe Causal Journeys

## Status

- Accepted; SDK foundation implemented, host collector and product instrumentation pending
- Date: 2026-07-11
- Owners: Analytics platform
- Package: `@plasius/analytics`
- Host collector: `Plasius-LTD/plasius-ltd-site`
- Rollout flag: `platform.analytics.semantic-journeys.enabled`
- Controlled server-replay flag: `platform.analytics.semantic-journeys.server-replay.enabled`
- Future viewer capability: `admin.analytics.semantic-journey-replay.view`

## Intent

Turn analytics from isolated interaction counters into a semantic causal ledger that can explain:

- what a person attempted;
- which interaction modality was used;
- which frontend and backend work followed;
- what state or presentation consequence occurred; and
- where evidence is incomplete.

The default ledger supports deterministic, replay-style inference on the user's device without recording screen contents, DOM snapshots, input values, request or response bodies, account identifiers, or other user-provided content. It is an explanation and diagnosis substrate, not a session-recording product.

## Privacy position

The design provides two deliberately different modes. They must never be blended or described with the same privacy claim.

### Local-private mode (default)

The semantic story remains in memory on the user's device. A bounded same-origin request trace lets the backend return safe semantic consequence receipts, which the client joins to the local story. The server receives only coarse, unlinkable aggregate counters with no journey, trace, event, producer, session, device, IP-derived, or user identifier. Collector infrastructure must not persist request IP addresses, user agents, referrers, or identity hashes for these aggregates.

This mode provides a PII-free event payload and avoids leaking the individual story to the service. The HTTP service will still transiently process network metadata needed to receive a request; the privacy claim is therefore about the journey payload and retained analytics data, not an assertion that no infrastructure ever observes an IP packet.

### Controlled-server mode (optional and off by default)

Uploading an individual semantic journey creates linkable behavioural evidence. It must be treated as pseudonymous Personal Data even when it contains no direct identifiers. This mode requires a separate remote flag, lawful-basis/consent review, short retention, erasure/export support, encryption, audited access, and a DPIA. Random or hashed identifiers do not make this mode anonymous.

A sufficiently detailed behavioural sequence can still single out or become linkable to a person when combined with other data. Consequently, the implementation must not describe a server-side journey as legally anonymous solely because identifiers are random or hashed.

Consequently:

1. No stable user, account, device, browser, IP, cookie, authentication, or cross-episode identifier is accepted.
2. Hashing an identifier is not an approved way to admit it to the journey contract.
3. Journey and purely local trace identifiers are cryptographically random, contain no embedded information, and rotate at bounded episode boundaries; propagated request traces rotate for every request. Local-private journey IDs never leave the device.
4. Capture is purpose-limited to operational explanation and product-quality evidence.
5. Local-private evidence is memory-only by default and expires at the episode boundary. Controlled-server evidence has short, enforced retention and is not joined to identity stores.
6. An identifiability review and DPIA are release gates for controlled-server capture, a production replay viewer, or longer retention.

## Package boundaries

`@plasius/analytics` owns:

- the versioned semantic journey contract;
- privacy validation and fail-closed attribute policy;
- random causal context creation, safe request-scoped propagation, and semantic receipt parsing;
- bounded client queues and adaptive batch construction;
- browser semantic interaction adapters;
- backend continuation helpers; and
- deterministic causal reconstruction and story inference.

`plasius-ltd-site` owns:

- remote flag evaluation and rollout;
- authenticated/authorised admin access to any future viewer;
- aggregate collector validation, rate limits, idempotent merge, and retention;
- trusted-origin handling and request context continuation; and
- production aggregate storage, projections, and operational metrics.

Controlled-server storage, deletion/export, and replay access are a separate delivery path guarded by the second feature flag.

`@plasius/graph-events` remains the graph-cache invalidation and projection package. Journey evidence must not reuse its arbitrary `DomainEvent.payload` contract.

## Semantic event contract

The v2 contract is additive and does not alter legacy `LocalSpaceAnalyticsEvent` records.

```ts
interface SemanticJourneyEvent {
  schemaVersion: "2.0";
  eventId: string;
  journeyId: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  causedByEventId?: string;
  producerId: string;
  producerSequence: number;
  occurredAtEpochMs: number;
  source: string;
  channel: "frontend" | "backend";
  runtime: "browser" | "server";
  name: string;
  category:
    | "interaction"
    | "navigation"
    | "request"
    | "command"
    | "state"
    | "presentation"
    | "dependency"
    | "error";
  phase: "intent" | "start" | "progress" | "end" | "effect";
  outcome: "unknown" | "success" | "failure" | "cancelled" | "denied";
  modality?: "pointer" | "keyboard" | "touch" | "voice" | "gesture" | "system";
  target?: { type: string; id: string };
  attributes: Record<string, boolean | number | string>;
  privacy: {
    mode: "strict";
    policyVersion: "strict.v1";
    droppedAttributeCount: number;
  };
}
```

Names, target fields, sources, effects, and string attributes are low-entropy catalogue tokens. They use a bounded token grammar and cannot be free text. Grammar alone is not treated as a privacy guarantee: sources require a catalogue-wide allowlist, while targets, effects, and attribute values require per-event allowlists:

```ts
defineJourneyEvent("checkout.submit", {
  category: "interaction",
  targets: [{ type: "control", id: "checkout-primary" }],
  effects: ["validation-accepted", "validation-denied"],
  attributes: {
    validationState: { type: "enum", values: ["valid", "invalid", "unknown"] },
    retry: { type: "boolean" },
  },
}, { sources: ["site"] });
```

Unregistered attributes, unknown top-level fields, and sensitive-looking keys or values cause the entire input to fail closed. They are never silently dropped or redacted into an apparently safe event. `droppedAttributeCount` is therefore zero for accepted strict-mode events; queue drops and progress coalescing are reported separately. The default event definition accepts no attributes.

### Never-capture fields

The journey API and automatic instrumentation must never capture:

- names, email addresses, telephone numbers, postal addresses, account or user IDs;
- cookies, tokens, credentials, authentication state payloads, or persistent device IDs;
- IP addresses, user agents, browser fingerprints, exact location, or cross-site identifiers;
- input, textarea, editor, clipboard, file, voice transcript, chat, prompt, or generated-content values;
- raw labels, accessible names, DOM text, DOM paths, CSS selectors, HTML, screenshots, or recordings;
- raw URLs, query strings, fragments, referrers, request bodies, response bodies, or database values;
- stack traces, exception messages, arbitrary log messages, or arbitrary context objects;
- product/cart/entity identifiers unless a separately reviewed event catalogue proves they are non-personal, bounded enum tokens.

Route templates, result classes, status families, validation states, feature keys, and developer-authored semantic target tokens are permitted when registered.

## Causal context

The story is a causal directed acyclic graph, not a claim of one global clock.

- `journeyId` groups one short-lived semantic episode locally and is never propagated in local-private mode.
- Every outbound request receives a fresh W3C-compatible `traceId`; cross-request causality remains exclusively in the local event graph.
- Request-scoped `traceId`, `spanId`, and `parentSpanId` link one frontend request to its returned backend consequences.
- `causedByEventId` links a consequence to the semantic event that triggered it.
- `producerId` and `producerSequence` establish monotonic order within one runtime producer.
- timestamps are evidence for presentation only; causal links and producer sequences take precedence.
- missing producer sequences and unresolved parent references become explicit gap markers.

IDs are generated with `crypto.getRandomValues` or `node:crypto.randomBytes`. `Math.random`, timestamps, user input, IP addresses, or device data must not seed identifiers.

Propagation is same-origin by default. In local-private mode, only a fresh request-scoped `traceparent` crosses the boundary; the local client maps that trace to its private journey. The backend returns a bounded, catalogue-validated semantic consequence receipt on the same response, containing outcome/effect codes but no application values or stable identifiers. No application data is carried in W3C baggage or tracing headers. Untrusted inbound contexts are validated and may be restarted.

Controlled-server mode may propagate a random episode identifier only to explicitly trusted origins, and it remains Personal Data governance-wise.

## Capture model

“Cover all interactions” means complete semantic coverage, not recording every low-level input signal.

The browser adapter uses delegated listeners and only records events on elements with explicit developer-owned semantic tokens such as `data-plasius-event="checkout.submit"`. It can represent:

- control activation;
- form submission without values;
- a field changing without its value or length;
- navigation to a registered route template;
- dialog/menu open and close;
- media start, pause, end, and failure;
- drag/drop completion without payload;
- accessibility modality when it can be determined without key/content capture; and
- custom application, 3D, voice, gesture, and game interactions through the same catalogue API.

Pointer movement, hover streams, scroll deltas, raw key events, focus churn, and input keystrokes are excluded. High-frequency semantic progress events are coalesced into counts or final states within a bounded window.

Backend code continues a validated incoming request context and creates semantic command, dependency, state, and response consequences. In local-private mode it returns a bounded receipt to the calling client and may update only coarse server aggregates. Helper APIs should make start/end/failure spans hard to omit and should never inspect request or response bodies.

## Adaptive batching and service load

The client maintains one bounded local queue per producer. Local-private events are batched for reconstruction and aggregation but are not uploaded. Aggregate batches are built using the first limit reached:

- maximum events per batch;
- maximum UTF-8 body bytes;
- maximum event age;
- lifecycle flush; or
- high-priority failure evidence.

Initial defaults:

| Control | Default |
| --- | ---: |
| Events per batch | 50 |
| Batch body | 48 KiB |
| Aggregate flush delay | 60 seconds |
| Queue events | 1,000 |
| Queue bytes | 1 MiB |
| Episode idle rotation | 30 minutes |
| Local event retention | Episode lifetime; memory-only by default |
| Aggregate collector retention | 30 days |
| Controlled-server raw retention ceiling | 24 hours |

SDK configuration cannot remove the safety bounds. Aggregate bodies are capped at 60 KiB, one flush at 20 batches, aggregate retries at five, request timeouts at 30 seconds, local queues at 5,000 events/8 MiB, event age at 24 hours, and episode idle duration at two hours. Aggregate intervals cannot be configured below one second; the production default remains 60 seconds.

The queue applies backpressure and an explicit priority/drop policy. Dropped and coalesced counts are represented locally and in coarse aggregate metadata. Sampling is decided once per journey so a retained local story is not made incoherent by per-event sampling.

Only one aggregate flush runs per client. Failures retain the exact aggregate body and batch ID for a bounded, jittered retry schedule, including across later `flush()` calls; retries honour cancellation, timeouts, retryable status classes, and `Retry-After`. `clear()` cancels the active aggregate generation so a stale acknowledgement cannot affect post-clear counts. Permanent validation failures are dropped with counters and never copied into logs or dead-letter payloads. The host collector deduplicates by aggregate batch ID.

The default Fetch transport sets `credentials: "omit"`, `referrerPolicy: "no-referrer"`, and `redirect: "error"`. Aggregate requests therefore do not intentionally attach cookies, authentication credentials, page URLs, or redirect-chain metadata.

## Batch contracts

The default wire payload is aggregate-only:

```ts
interface SemanticJourneyAggregateBatch {
  schemaVersion: "2.0-aggregate";
  batchId: string;
  source: string;
  channel: "frontend" | "backend";
  runtime: "browser" | "server";
  timeBucket: string;
  policyVersion: "strict.v1";
  dropped: number;
  coalesced: number;
  counters: Array<{
    eventName: string;
    outcome: "unknown" | "success" | "failure" | "cancelled" | "denied";
    count: number;
  }>;
}
```

It has no individual-event timestamps or causal identifiers. The collector must aggregate it without storing request identity metadata and must suppress low-cardinality query results to reduce singling-out and differencing risk.

The following contract exists only for controlled-server mode:

```ts
interface SemanticJourneyBatch {
  schemaVersion: "2.0-controlled";
  batchId: string;
  source: string;
  channel: "frontend" | "backend";
  runtime: "browser" | "server";
  sentAtEpochMs: number;
  policyVersion: "strict.v1";
  dropped: number;
  coalesced: number;
  events: SemanticJourneyEvent[];
}
```

The collector returns a bounded acknowledgement with accepted, duplicate, permanently rejected, and retryable counts. It does not echo events, identifiers, or rejected values. Local-private aggregate acknowledgements contain counts only.

## Replay-style inference

Local reconstruction is deterministic:

1. Validate the catalogue and every event; fail the reconstruction closed if any evidence is invalid or a graph/work bound is exceeded.
2. Partition by journey and producer.
3. Verify producer sequences and emit gaps.
4. Build edges from span parents and causation references.
5. Topologically order the graph with timestamp/event ID tie-breakers.
6. Collapse start/end pairs into semantic steps.
7. Render catalogue-controlled explanations.

Example output:

```text
Activated checkout.submit by keyboard
  -> frontend validation ended: success
  -> request checkout.create started
  -> backend command order.create ended: denied
  -> frontend presentation checkout.problem shown
Evidence: partial (one backend producer sequence missing)
```

Inference never receives raw application payloads or general logs. In local-private mode the semantic graph does not leave the device. Optional model-based summarisation is controlled-server processing, may consume only the validated semantic graph, and must preserve deterministic evidence links and uncertainty markers under the Personal Data controls for that mode.

## Rollout and access control

`platform.analytics.semantic-journeys.enabled` is remotely evaluated by the site feature-flag service and defaults to disabled. It enables local-private capture plus aggregate transport. Hosts pass the resolved decision into `@plasius/analytics`; a local environment variable is break-glass/local-development only.

`platform.analytics.semantic-journeys.server-replay.enabled` independently gates controlled-server upload and defaults to disabled. It must remain disabled until the DPIA, lawful basis/consent, retention, deletion/export, and access-control gates are complete.

Disabled or rollback state:

- no semantic journey listeners are installed;
- no v2 journey records are queued or sent;
- existing v1 analytics continues unchanged; and
- the collector rejects or ignores v2 aggregate/controlled batches according to its rollout policy.

Existing v1 analytics contains unrestricted context and stable/linkable fields. It is a migration compatibility path, not part of the privacy-safe claim. Producers must move to registered semantic events, and the collector must retire or strictly govern v1 before the overall service can claim that it does not retain individual Personal Data.

The SDK itself is not user-visible, so it needs no capability. A future admin replay surface requires `admin.analytics.semantic-journey-replay.view` in addition to the feature flag and normal admin authorisation.

## Security and abuse controls

- Validate limits before allocating or traversing nested input.
- Require reviewed immutable allowlists for sources, targets, consequence effects, and enum values; token grammar alone is not a privacy classification.
- Reject malformed IDs, tokens, enum values, timestamps, and causal links.
- Bound graph size, fan-out, reconstruction time, queue memory, and request body size.
- Treat inbound trace context as untrusted and restart invalid/untrusted contexts.
- Do not include rejected values in exceptions, logs, metrics, or acknowledgements.
- Use low-cardinality metrics; event names and journey IDs must not become metric tags.
- Enforce same-origin propagation by default and TLS for remote endpoints.
- Keep aggregate collector storage private, retention-managed, and separate from identity data; never persist source request IP, user agent, referrer, cookie, or identity hashes.
- Apply full encryption, erasure/export, audited access, and Personal Data controls to controlled-server storage.

## Observability

Low-cardinality counters and histograms:

- events accepted, dropped, coalesced, invalid, and expired;
- batch size by count and bytes;
- flush latency, success, retry, timeout, and permanent failure;
- queue depth and oldest event age;
- reconstruction complete/partial/invalid counts; and
- causal gap counts by safe reason code.

No metric tag may contain journey, trace, event, producer, target, route, or user-controlled values.

## Verification strategy

Tests are derived from this design before implementation.

### Privacy

- Canary emails, names, tokens, URLs, IPs, cookies, request bodies, DOM text, and input values never appear in queue storage, wire payloads, errors, metrics, acknowledgements, or inferred stories.
- Stable identifiers are rejected even when hashed.
- Automatic instrumentation records only registered semantic tokens.
- IDs are random, bounded, and rotate without identity-derived seed material.

### Causality and replay

- Frontend interaction -> request -> backend consequence -> presentation reconstructs deterministically.
- Out-of-order delivery produces the same graph.
- Duplicate events are idempotent.
- Missing sequence and parent evidence is explicit.
- Cycles, excessive fan-out, malformed trace context, and mixed journeys fail safely.

### Batching and reliability

- Count, byte, age, queue, and lifecycle limits produce bounded batches.
- Coalescing reduces high-frequency events without losing the final semantic state.
- Concurrent flush requests do not duplicate transport calls.
- Timeouts, cancellation, transient failures, permanent failures, and retry exhaustion are bounded.
- A restart clears the memory-only individual story; aggregate counters may be rebuilt only from events accepted after restart.

### Rollout

- Enabled, disabled, and rollback behavior are covered.
- Legacy v1 analytics behavior remains compatible.
- Future viewer tests cover both feature flag and capability authorisation.

## Delivery slices

1. Contract, catalogue validation, causal context, batch builder, and deterministic reconstruction in `@plasius/analytics`.
2. Safe browser semantic adapter and backend continuation helpers.
3. Site feature flag plus v2 collector validation, idempotency, retention, and acknowledgements.
4. Site-wide semantic catalogue and instrumentation of key frontend/backend consequence paths.
5. Admin viewer capability, privacy review, replay UI, and operational rollout.

## Release gates

- Package lint, typecheck, unit tests, coverage, build, and packed-artifact validation pass.
- Every changed source file appears in combined LCOV and coverage remains at least 80%.
- Site collector/integration tests and required site gates pass for host changes.
- ADRs, README, changelog, rollout/rollback instructions, and retention controls are updated.
- GitHub Project hierarchy, ownership, status, and CI are verified.
- Controlled-server production rollout remains disabled until the identifiability review/DPIA, lawful-basis/consent, retention, deletion/export, and access controls are approved.

## Standards references

- W3C Trace Context, especially privacy and random trace ID requirements.
- W3C Privacy Principles, especially data minimisation and purpose limitation.
- OpenTelemetry sensitive-data and context-propagation guidance.
- ICO anonymisation, pseudonymisation, and storage-limitation guidance.

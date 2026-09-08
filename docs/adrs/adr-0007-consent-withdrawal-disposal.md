# ADR 0007: Discard retained analytics on consent withdrawal

Status: Accepted

The host owns consent and must not construct an optional analytics client before
consent is granted. On withdrawal it calls `destroy({ discard: true })`, which
aborts transport, clears persisted and in-memory events and issue aggregates,
and prevents late completion from recreating data. Custom transports receive an
optional AbortSignal and must honour it. Already-delivered requests cannot be
recalled. Ordinary `destroy()` preserves its existing persistence semantics.

The semantic journey client's existing `destroy()` already aborts/discards.
This additive legacy API permits safe host integration during migration without
changing event contracts or creating a second transport. Host rollout flag:
`site.privacy.optional-processing.enabled`. Tracking: site Feature #2206,
Story #2207; analytics Task #54.

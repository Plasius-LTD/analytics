# ADR 0008: Catalogue-owned aggregate projections

- Status: Accepted for implementation
- Date: 2026-09-08
- Task: #55; site Story #2160 / Feature #1464 / Epic #1463

## Context

Strict 2.0 aggregates preserve only event/outcome totals. Forwarding arbitrary
attributes to support screen/world reporting would widen the privacy boundary;
separate service allowlists also drift from application catalogues.

## Decision

Add opt-in 2.1 aggregate views over explicitly selected existing enum attributes.
Compile immutable application producer bindings, projections and ingress
validation from one reviewed policy. Preserve the strict 2.0 input/output path
for clients without the new policy. Numeric and boolean attributes are not
projected; timing and gesture counts must first become finite bucket tokens.

Independent views include a dimensionless total and must not be summed together.
Bound policy/cardinality, rows, bytes, ages, retries and concurrent snapshots.
Reject batch ceilings that cannot fit every approved single-row envelope at
construction, including maximum counter and diagnostic values. Check per-batch
overrides against the same bound so no accepted row can strand the queue.
Preserve original observation hours and never extend expiry through retry.
Expire a pending hour together if its oldest row expires, preventing surviving
view cells from outliving their total. Report conservative discards explicitly.

Retain existing local-private replay and transport. No individual IDs, private
context or target objects cross into the aggregate contract. Hosts evaluate
consent and stored flags before creation and destroy/discard on withdrawal.
Retention, immutable storage, processing, report suppression and deployment are
host responsibilities; an SDK release is not organisation-wide certification.

## Consequences and verification

One policy must be shipped to producers and service validators together. Exact
source/channel/runtime tuples require review. A finite grammar alone does not
prove anonymity. The default-off coverage rollout prevents pre-consent or
unreviewed host collection; rollback must not restore unrestricted legacy data.

Tests cover unsafe policies/payloads, immutability, unknown fields, exact binding,
duplicate keys, row/byte/cardinality bounds, original-hour batching, expiry,
retry, concurrent additions and cancellation. Package quality, changed-source
coverage, CI and approved CD are required before consumption.

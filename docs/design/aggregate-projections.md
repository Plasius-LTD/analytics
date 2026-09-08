# Catalogue-owned aggregate projections

Implementation task #55, parent site Story #2160 / Feature #1464 / Epic #1463.
Approved completion design: site `docs/Design/event-coverage-completion.md`.

## Boundary

The existing 2.0 aggregate format retains event/outcome totals only. An opt-in
2.1 format adds explicitly reviewed views over finite enum attributes. It never
forwards an attributes object, target or causal context wholesale. Every view is
independent; consumers must not sum different views as if they were different
events. A reserved `total` view has no dimensions and preserves event totals.

An immutable aggregate policy couples the existing semantic catalogue with
exact source/channel/runtime bindings and per-event named views. Each view lists
at most four existing enum attributes; numeric/boolean attributes, missing
definitions, unsafe view tokens, duplicate dimensions and excessive cardinality
are rejected during construction. Missing optional dimensions omit that view,
not the total. Invalid supplied event fields reject the whole event.

The package generates ingress validation from this same policy. Strict 2.0
input accepts only event/outcome/count. Strict 2.1 rows require event/outcome/count,
view and exactly the registered dimension keys/values. Unknown envelope fields,
private IDs, unknown producers, duplicate counter keys, unsafe integers and
oversized batches fail closed without reflecting input. A shape-valid source
token is not sufficient: the full producer binding must be registered.

## Client and memory

`aggregatePolicy` opts the shared client into 2.1. No policy preserves its
existing 2.0 behaviour. Projection uses validated semantic inputs before private
context can cross the boundary. Shared transport remains the only sender.

2.1 accumulators keep the original observation hour, not flush time. Different
hours never share a batch. Exact batch snapshots survive bounded retries;
acknowledgements subtract only their original hour/view counters and preserve
concurrent additions. Bound pending rows and bytes as well as local events;
expiry, capacity rejection and cancellation must not resurrect discarded data.
Turning consent/remote permission off destroys/discards through the host's
lifecycle; importing the package installs no observers or senders.

At construction, the projected store checks `maxBatchBytes` (48 KiB by default)
against the largest approved single-row envelope, including maximum safe counts
and diagnostics. The client supplies its `aggregateMaxBytes` to this check.
Incompatible configurations fail before capture; a later per-batch override
must also fit every approved row and stay within the configured ceiling. This
prevents a valid large projection from indefinitely blocking later counters,
without dropping partial views or exceeding the caller's byte budget.

## Delivery and acceptance

No source change to legacy core/react consent disposal (#54) belongs here.
The host owns consent, stored flags, retention, processing, low-volume report
suppression and production deployment. Inherit the parent's default-disabled
stored flag; new host adapters additionally require coverage permission. This
package release neither enables production capture nor certifies all repos.

Tests precede implementation: policy bounds and mutation, catalogue/producer
validation, finite projections, omitted views, sensitive/unknown input, exact
wire shape, duplicate keys, size/overflow bounds, original-hour rollover,
acknowledgement/retry/concurrent additions, cancellation and bounded memory.
Run all package gates and changed-source LCOV >=80%; release only through
approved GitHub CD before application consumption.

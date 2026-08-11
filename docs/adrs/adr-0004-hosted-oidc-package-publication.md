# ADR-0004: Hosted OIDC Package Publication

- Status: Accepted
- Date: 2026-08-11

## Context

`@plasius/analytics` must be published from an approved GitHub workflow without
a long-lived npm write credential. Publication must not race a newer `main`
commit or accept CI evidence from another event or SHA.

## Decision

Publication is phase-isolated: dependency installation, package validation, SBOM generation, and immutable tarball packing run in `validate_and_pack` without the `production` environment or OIDC permission. The final hosted `publish` job downloads only that sealed artifact, explicitly installs npm 11.6.2, runs no repository dependency code, and publishes the tarball with lifecycle scripts disabled. It re-fetches current `main` immediately before the first release mutation and again immediately before npm publication. `.npmrc` contains no registry-auth placeholder, and release preparation returns the reviewed current `main` HEAD rather than package-file history.

Publish only from the `ubuntu-latest` job in `.github/workflows/cd.yml`, guarded
by the GitHub `production` environment and npm's GitHub Actions trusted
publisher. Before publication, prove that the prepared commit is the exact
remote `main` head and that push-triggered `ci.yml` succeeded for that SHA.
Require Node 24 and npm 11.5.1 or newer, request provenance, and reject all
`NPM_TOKEN` and `NODE_AUTH_TOKEN` fallbacks.

## Consequences

An npm owner must configure the package's trusted-publisher binding before the
workflow is dispatched. A moved `main`, absent exact-SHA CI evidence,
unsupported runtime, or missing OIDC identity fails closed without publishing.

## Test implications

Workflow contract tests require the hosted production publisher, exact-main
admission, runtime guard, provenance, and absence of long-lived npm credentials.

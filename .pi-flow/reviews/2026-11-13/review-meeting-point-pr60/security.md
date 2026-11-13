# Security and provider-boundary facet

Fixed review: base `9ab7a4accade272f5b602b0812e2518f9e2b5ccb` to head `d3d381ff1048e4e9e5566c76a30b8fdc79b6addb`. Reviewer: Sonnet 5.5, high, source-only; no tests or provider calls.

No concrete security findings. Reviewed Photon shape/coordinate checks, bounded in-memory caching, React text rendering, build-time endpoint trust, Overpass decoded-byte/time/graph limits, same-origin persistent-cache validation, disclosures, autocomplete abort/stale-reply handling, and the developer importer. Browser fetch configuration is not a server-side SSRF boundary.

The reviewer did not treat an unbounded Photon response body from a fixed/deployer-controlled provider as an established exploit, or latitude rejection above the study-area limit as a security defect. No compatibility shim or provider retry requested.

Review result: Approve.

# PR60 review synthesis and implementation contract

Reviewed `9ab7a4accade272f5b602b0812e2518f9e2b5ccb...d3d381ff1048e4e9e5566c76a30b8fdc79b6addb` before application edits. Six independent facets: product spec (daily), standards (Astra), benchmark validity (Sol), security (Sonnet 5.5), data/loading UX (Opus 5.5), and preservation/tests/CI/docs (Fable 5.2). All used high or lower effort. Standards and Spec findings remain separate in their reports.

## Decision

No critical/high findings. Do not change the measured no-go: JavaScript routing and Canvas2D stay production. Preserve all four archives and the source branch; never restore the losing prototype as a runtime dependency. Resolve the concrete UX/benchmark findings and accepted durability/coverage improvements, then verify and squash only the exact passing head.

## Confirmed parent reproduction

On the unchanged deployed `d3d381f` preview, viewport 360×1000, reduced motion, final SF routes: canvas CSS width 326. Candidate 6 (Market Street & Portola Drive, node 63940) lies 15.97695 px from candidate 1 (21st Street & Eureka Street, node 56474). The visible 6 glyph was clicked at its projected center. Selection remained candidate 1 and candidate 6 remained `aria-pressed=false`. Screenshot plus live DOM readback confirmed the wrong hit target. Owned browser tab was closed.

## Bounded implementation slices

- Marker owner: reverse paint-order actual-footprint hit testing before expanded touch padding; keep reveal threshold, selected size, opacity scaling, stroke footprint and existing map/session behavior. No per-frame marker allocations.
- Autocomplete owner: click-only suggestion selection with mouse focus preservation; uncancelled touch scroll; origin-scoped stale-error rendering. No provider behavior changes.
- Benchmark owner: complete trees/candidate fields/contacts fingerprinted against the comparison reference, outside timed frame intervals, without copying/retaining a history of result buffers. Add a real corrupted-parent negative control and meaningful parity tests. Expose only small last-completed-search metadata for memory observations. No frozen gate relaxation or historical-report rewrite.
- Loader-test owner: isolated deterministic real loader/cache boundary tests; no public providers or fixture re-import.
- Parent: observed (not hardcoded) memory-workload metadata, review integration, CI/docs/changelog, focused execution, exact-head preview/push/merge.

## Remaining evidence boundary

Static review is not an execution pass. Parent execution and its qualifications are now recorded in [fixes-and-verification.md](fixes-and-verification.md). No new performance speedup or hardware coverage is inferred from those checks.

Aggregate integration result: Accepted findings resolved; approve with the recorded verification qualifications. Original facet verdicts apply only to the frozen reviewed head, not an unperformed independent re-review of the fixes.

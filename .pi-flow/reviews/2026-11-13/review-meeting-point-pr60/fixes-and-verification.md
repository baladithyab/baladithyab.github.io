# Integrated findings and verification

Review boundary: `9ab7a4accade272f5b602b0812e2518f9e2b5ccb...d3d381ff1048e4e9e5566c76a30b8fdc79b6addb`. Six independent facets are preserved separately. Their original source-only verdicts are not relabeled as re-reviews of the fixes. Parent integrated bounded Astra/Opus implementation slices and performed the execution below.

## Product fixes

- **Marker picking:** one reverse paint-order pass prioritizes actual animated circle/stroke footprints over16px padding. Drawing/picking share radius/stroke geometry; reveal eligibility stays unchanged. Reproduced visible SF candidate6 incorrectly selecting1 at326CSSpx, then verified the same click selects Market Street & Portola Drive. Two pure regression cases cover actual overlaps, padding and reveal eligibility.
- **Touch autocomplete:** select on click, preserve mouse focus, leave touch scrolling uncancelled and avoid touch hover auto-scroll. Trusted Chromium CDP touch-down no longer selects; a swipe scrolled200px with list open and blank input; a lower-item tap selected The Castro. Mouse and ArrowDown/Enter selected Pier39 and closed the list; mouse focus remained on the starting input. This is emulated touch, not a real-device claim.
- **Stale error:** scope error to the immutable Origin that produced it. A controlled Photon fixture more than200m from a path still alerts and disables Find. Reset restored the identical Golden Gate Bridge name with no alert/invalid flag; a map correction to21st Street & Eureka also cleared the alert and enabled Find. One intercepted fixture response, no actual provider query.
- **Map smoke:** zoom and pan changed screenshots without changing originA; Fit visually restored the map. An overly strict full-WebP-equality assertion failed. After clearing toolbar hover, decoded differences were confined to the outer right8px; the remaining400×408 map image matched. The raw proof preserves this limitation rather than claiming byte-identical screenshots. Owned browser tabs/server were closed; no page errors were observed.

## Benchmark and memory fixes

- **Current runner r5:** complete request/tree shape, exact distance/parent view bytes, every candidate field and collision data are fingerprinted after measured intervals, one digest at a time, with no concatenated tree copy or retained result history. Fingerprints and last-completed metadata are benchmark-only. Frozen r4 timing thresholds, eligibility scope and historical reports are unchanged.
- **Real negative control:** the production worker body with all returned parents filled with−1 emitted8 observed corruption measures. The old harness incorrectly reported passed. R5 rejected the same control with `current vs worker differ in parents` (expected exit1).
- **Valid control:** local SF current/scalar/external-identity-worker smoke, groups4/16, passed38 consistency keys and13 complete-output comparisons against current. No promotion/speedup claim.
- **Memory metadata:** schema2 observes matched successful reply plus valid rendered input count. Actual cold counts4/4 and warm counts16/16 were recorded, not inferred from configuration. The raw report exposes unavailable heap/OS coverage separately; no leak or aggregate-memory improvement is inferred. Historical phase0 two-start captures remain unchanged.
- **Limits:** hashing is outside timed windows but not free; it can affect cache/GC between samples. Recollect both reference and candidate under the same current runner before any promotion. Cancellation recovery is fingerprinted when exercised but not cross-engine pooled; cached reranks compare rendered candidates and reuse the originating worker fingerprint, not React state.

## Deterministic and build checks

- 27 tests passed across the three affected files. After fixing the new Cache-request stub's URL handling, the eight loader cases passed again; these overlap the 27, not 35 distinct tests. Coverage includes streamed/header limits, refusal without retry/cache, exact seven-day expiry, fourth-area eviction and malformed-cache recovery.
- Removed the proposed SF fixture-shape snapshot and exact UI-error wording assertions; full SF loading is exercised through the actual page and benchmark rather than a hardcoded count/first-item test.
- Affected tests passed strict typechecking inheriting `tsconfig.test.json`, with only includes and package-resolution roots scoped. The initial whole test-project check reported 22 diagnostics: one new URL/Request union issue was fixed; 21 were in unchanged GitHub/Gatus/blog/R2/runtime/project-manifest files. That broad check was not rerun, and no unrelated fixes or full-project pass are claimed.
- `astro check`: 90 files, 0 errors, 0 warnings, 3 hints. `bun run build` built energy-ring and Deep Brush, then the site successfully. Existing Tailwind source-map warning remains.
- Preview/deploy no longer explicitly run WASM generation before `bun run build` repeats it. Build still generates both crates before typechecking.

## Preservation and release

Updated architecture/current-crate descriptions, replaced machine-specific evidence references with archive keys, documented the root Cargo CRLF distinction, and recorded full prototype/retention SHAs plus branch-fetch recovery. The original four gzip archives are untouched; the retained remote branch preserves the historical commits through squash.

New portable evidence: `docs/benchmarks/meeting-point-premerge-review.json.gz`, SHA-256 `d4811a1d0e220d835e5de4558ce93965cf7e40860ea0ea0b11b1e89a2af3ebfb`, 200,357 bytes. It contains four path-redacted reports with original hashes/byte counts, both unchanged control-worker sources, UI observations, checked source hashes and path-redacted check output. Portability validation preserved all 32,485 numeric report leaves and non-path data. Timing smoke processes overlapped other local verification and are not controlled performance evidence.

Workstation paths use `<repo>`, `<temp>` and `<home>` placeholders. The pre-portability archive and its original bytes remain in retained branch history at `86a8fc8521279d92cb87fde86d3bd21d18805dbd`; this is a portable current view, not a history-purge claim. The four historical experiment archives remain untouched.

Release remains gated on pushing the exact verified changes, obtaining the matching Cloudflare preview/checks, and squash-merging only that head without deleting the branch or bypassing policy.

Integration result: Accepted findings resolved; focused execution passed as qualified above.

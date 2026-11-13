# Preservation, tests, CI and documentation facet

Fixed review: base `9ab7a4accade272f5b602b0812e2518f9e2b5ccb` to head `d3d381ff1048e4e9e5566c76a30b8fdc79b6addb`. Reviewer: Fable 5.2, high. Read-only git/archive inspection; no test, build or performance run.

## Accepted improvements

1. Add behavior coverage for the live-network loader's streamed byte cap, provider errors, persistent-cache expiry/eviction/corrupt-entry recovery, and the bundled SF preset. Existing coverage only exercises region bounds.
2. Record full prototype/retention commit IDs, retained branch, PR and a fetch command so a main-only clone can retrieve the archived historical checkout after squash.
3. Remove redundant explicit WASM builds from preview/deploy jobs: `bun run build` already builds both energy-ring and Deep Brush. Keep the build job's pre-typecheck generation. Correct its comments/documentation.
4. Correct two stale current-audio-only statements; distinguish the original research baseline from the merged build's two crates.
5. Replace machine-specific temporary evidence paths with durable archive keys. Mark the unarchived filtered smoke report honestly.
6. Document the meeting-point worker, static fixture, Photon/Overpass calls and endpoint overrides in `ARCHITECTURE.md`.
7. Document the archived root `Cargo.toml` CRLF distinction; do not rewrite immutable historical evidence.

## Preservation verified by reviewer

All four gzip archive hashes match their documented values. Ten Phase 1 report texts, three compiled variants/glue, sixteen source snapshots and the frozen contract are present; root Cargo line endings are the sole reported source-byte difference. Phase 0 and closeout report hashes match. The archive contains the prototype sources needed independently of active production packages.

Routing/collision/traversal/geocoder/network/parity tests assert behavior rather than source text. Gate scope and failed Rust promotion claims remain consistent. GPU/traversal offload were not benchmarked losses. Safari/mobile/weak-GPU coverage is not claimed.

Review result: Approve with comments; integrate the accepted improvements before merge.

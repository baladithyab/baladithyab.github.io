# Benchmark/evidence facet

Fixed comparison: `9ab7a4a...d3d381f`. Reviewer: native `Pr60BenchReview` (`deliberate-sol`). Source reasoning only; no execution or archive inspection.

## Standards

No concrete findings. Completed coverage takes per-engine/per-cross-product minima; no sample-pooling finding. Submission/rAF measurements are distinguished from GPU completion/presentation.

## Spec

### Medium: generic-worker correctness coverage is incomplete

`ui.tsx` retains only candidate node/name/longest/total; `meeting-ui-bench.mjs` consistency checks compare those summaries and cached labels. Complete distance/parent arrays, candidate per-origin breakdowns and collisions are not compared for an external `--engine worker` override.

Reachable scenario: an override with correct distances/ranking but parents filled with `-1` satisfies current summary comparisons while routes collapse. A faster such override could be assigned a passed promotion gate. The numerical harness covers current/scalar only. This does not establish an error in the archived rejected prototype.

Suggested fix: complete-output fingerprints against reference outside timed intervals, covering every distance/parent value, every candidate field and collisions; or exact-build parity evidence required before a passed promotion.

### Medium: retained-memory workload metadata is stale

`meeting-ui-memory.mjs` describes a two-start retained result, but its 4/16 invocation and current runner's final-group cancellation/recovery retain sixteen starts. Capture occurs before unload. New reports therefore mislabel workload-based memory observations.

Suggested fix: derive retained origin count from observed recovery data; do not change the workload to match the label. Historical reports remain historical.

Review result: changes requested

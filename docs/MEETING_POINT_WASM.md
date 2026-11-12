# Meeting-point acceleration: research and implementation plan

Status: proposed; planning only. No routing or renderer cutover is included.

Research date: 2026-11-12. Repository baseline: `12b181e93f77928fb6c6662a7a1cac1f78e573e9`.

## Decision

Proceed in this order:

1. Establish a browser benchmark and an allocation-reduced JavaScript baseline.
2. Prototype a small, single-threaded Rust/WASM routing crate inside the existing retained worker. Keep ranking, collisions, playback and Canvas2D unchanged.
3. Promote WASM only if complete worker-to-UI measurements justify its download, initialization, packing and output-copy costs.
4. Investigate traversal preparation separately if browser traces still identify it as a bottleneck.
5. Prototype direct WebGL2 street/trail rendering only if rendering remains a demonstrated problem. Keep CPU routing authoritative.
6. Defer `wgpu`/WebGPU and WASM threads. Revisit for an actual native-client requirement or a demonstrated workload that needs their additional capabilities.

This is not a promise that WASM or a GPU renderer will be faster. The benchmark gates below decide whether each experiment ships.

City/address lookup and the remote road query remain separate concerns. None of these local accelerators fixes Photon/Overpass availability or time spent waiting for their responses. [R2]

## 1. Evidence and current contracts

### Recorded CPU measurements

Earlier measurements in this thread used the bundled SF graph: 105,016 nodes and 144,385 edges, Bun 1.4.4, two warmups and the median of five runs. They were not repeated during this research step.

| Starting locations | Search including ranking | Traversal-bucket CPU | Contact calculation |
| ------------------ | -----------------------: | -------------------: | ------------------: |
| 4                  |                 133.6 ms |              22.0 ms |             0.03 ms |
| 16                 |                 623.8 ms |              91.7 ms |             0.23 ms |

These are independent CPU microbenchmarks, not summed pipeline timings. They exclude browser scheduling, rasterization, GPU execution, network latency and WASM. They identify candidate work, not an accelerated speedup or a browser responsiveness score.

The current implementation already prepares CSR adjacency once, retains it in a worker, transfers distance/parent buffers, caches the last group's trees for reranking, and uses selected-result-independent traversal buckets. Avoid benchmarking a Rust implementation against the obsolete per-search adjacency-building implementation. [R1] [R2] [R3]

### Current ownership

- `MeetingPoint` owns session/search identity, origins, objective, completed-tree reuse and real cancellation by worker termination. An idle worker is retained. [R3]
- `meeting-point.worker.ts` owns graph loading/preparation, routing, contact calculation and transferable result delivery. [R2]
- `meeting-point.ts` owns the graph/types, CSR Dijkstra, ranking, separation and route reconstruction. [R1]
- `MeetingPlayback` owns the continuous clock and selection commands; `MeetingMap` owns geometry, raster caches and map interaction. [R4] [R5]
- The existing Rust workspace includes `crates/*`, but the build script currently compiles only the audio lab. Generated `pkg/` must remain outside `src/`. The audio lab is a build-pattern reference, not a routing dependency. [R6] [R7]

### Non-negotiable behavior

- Complete distance and parent trees for every origin, including unreachable sentinels; no early exit at the first meeting point.
- `f64` / `Float64Array` distances, original edge insertion order, strict-shorter relaxation and the existing heap's equal-priority behavior. Do not substitute a tuple-ordered Rust `BinaryHeap` and assume identical parents.
- Both objectives, deterministic ranking, duplicate-origin behavior, node deduplication, up to ten named candidates, and at least 400 m between accepted candidates.
- Pair contacts at the midpoint of a shortest road path, including interpolation inside an edge; the existing deterministic pair ordering.
- Busy cancellation, stale-reply rejection, region reset, same-area reuse and cached reranking without running Dijkstra again.
- Pause, replay, backward seek, speed, direct-to-routes result selection, the eased final reveal, reduced motion, theme changes and map hit testing. [R1] [R2] [R3] [R4] [R5] [R8]

## 2. Platform findings that affect the design

### WASM is not a zero-copy replacement for the current worker

`wasm-bindgen` copies exported numeric slices into WASM memory and copies returned boxed numeric slices into ordinary JS typed arrays. Borrowed mutable slices also require copy-back. Keep these crossings coarse-grained and measurable. [P1] [P2]

A non-shared WASM memory buffer has the `WebAssembly.Memory` detach key. The structured-transfer algorithm cannot detach it like an ordinary transferable `ArrayBuffer`. Growth of fixed-length WASM memory also invalidates old buffer views. Do not send the live WASM heap as the current worker's transfer payload, or hold unsafe views across calls that may allocate/grow memory. [P3] [P4]

A Node 24.15.0 probe run during this research observed:

- An ordinary 8-byte buffer transferred successfully and detached the source.
- Transferring `WebAssembly.Memory.buffer` threw `DataCloneError`.
- Growing memory detached the previous buffer/view.
- Listing the same ordinary buffer twice in a transfer list threw `DataCloneError`.

This verifies those ownership cases in Node/V8, not an entire browser implementation. Repeat them through the actual browser worker when implementing.

Use safe owned-array exports first. For `V` graph nodes and `N` origins, distances plus parents contain `12 * V * N` bytes before any temporary storage. For the SF graph this is approximately 4.81 MiB for four origins and 19.23 MiB for sixteen. Count the WASM-to-JS copy and WASM memory high-water mark in the promotion decision.

### Single-threaded WASM first

The normal `wasm32-unknown-unknown` target is not a transparent native thread environment; `std::thread::spawn` is unsupported. Sharing WASM memory between browser workers brings cross-origin isolation and synchronization requirements. This phase needs neither `SharedArrayBuffer`, Rayon nor COOP/COEP changes. [P5] [P6]

The current workspace optimizes release builds for size (`opt-level = "s"`). Compare that with speed-oriented settings for the routing package only. Do not retune the audio renderer or enable an unpinned optimizer globally; the existing project documents a Binaryen compatibility problem. [R6] [R7] [P7]

### GPU rendering is distinct from GPU routing

`wgpu` 30.0.1 can target WebGPU or WebGL2 on WASM, with different backend features. Its optional WebGL backend is not a compute-capable replacement for WebGPU. WebGPU API exposure alone does not guarantee a usable adapter/device. [P8] [P9] [P10]

WGSL has `f32` and optional `f16`, not a concrete runtime `f64` type. Its abstract floating-point type is not a way to store and execute this routing contract in double precision. A GPU shortest-path implementation would also change the heap/relaxation strategy and require new tie/parity proofs. Do not put routing on the GPU in this plan. [P11]

WebGL2 can render precomputed road fields without owning the routing result. Prefer instanced segment quads over relying on a particular implementation's wide-line range. GPU context loss, shader/setup failure, resize and restoration are required lifecycle cases, not just initialization checks. [P10] [P12] [P13]

OffscreenCanvas can move drawing away from the main thread, but is a separate execution-location experiment, not proof of faster total drawing. Transfer must happen before obtaining a context from that canvas. Feature-detect the actual context and worker path; do not add it simultaneously with the first routing or GPU cutover. [P14]

## 3. Proposed Rust/WASM design

### Responsibilities

Add a separate `crates/meeting-point` compute crate. It must not depend on `energy-ring`, `web-sys` graphics APIs or `wgpu`.

Rust owns:

- Retained CSR adjacency with `u32` indices and `f64` weights.
- A custom heap matching the existing comparison/tie behavior.
- Complete Dijkstra trees for a requested origin batch.
- Checked size/index handling and explicit allocation errors where supported.

JavaScript keeps graph retrieval/validation, place metadata, candidate ranking, geographic separation, collision interpolation, UI state and rendering initially. This avoids mixing a compute port with changes to geographic/transcendental calculations or presentation semantics.

### Private adapter and data lifetime

Use one private worker-side adapter; do not introduce a general backend/plugin framework.

1. At worker startup, begin one cached WASM initialization promise.
2. Load/validate the graph using the existing loader. WASM initialization and graph retrieval may overlap; publish `ready` only after both succeed and CSR is prepared.
3. Pack original edge endpoints and weights once, preserving order. Copy them into Rust once and retain the prepared graph there. Do not repack the full graph on each search.
4. Send only origin indices to the routing kernel per search. Keep the existing objective ranking in JS after tree export.
5. Export two owned, origin-major blocks: `Float64Array[N * V]` distances and `Int32Array[N * V]` parents. Create per-origin `subarray` views for the existing `SearchTree[]` consumers; no per-row copies.
6. The worker transfer list must contain the two unique backing buffers once each. The existing `trees.flatMap(...buffers)` would list shared backing buffers repeatedly and must be migrated.
7. Consuming output methods must release Rust batch ownership deterministically. Avoid cloned getters and extra intermediate serialization. Inspect generated glue to confirm copy counts.
8. Replacing a prepared Rust session frees its owned object. Worker termination remains the actual cancellation mechanism; no claim of cooperative cancellation while synchronous Rust is executing.

The expected adapter shape is asynchronous preparation followed by a synchronous batch solve returning owned JS trees and their unique transferables. Keep raw pointers and unsafe borrowed memory views out of the initial public surface. Exact generated binding names can be chosen during implementation; ownership and output layout are the contract.

Use checked arithmetic before allocating `N * V` arrays. Do not silently cap the group, truncate results or downcast routing distances to `f32`. A memory failure must produce a clear error, not fabricated results.

### Preserve message ordering during asynchronous startup

Today `attach` is synchronous and emits no success reply; the immediately following search depends on that. Simply adding `await initWasm()` to an independent handler creates an ordering hazard. [R2] [R3]

Serialize incoming worker requests through one private FIFO promise chain. Each handler completes initialization/preparation before the next queued request runs. Keep error handling from leaving a poisoned queue, retain the current search IDs, and preserve the parent's termination/session-identity guards. Do not add an `attached` acknowledgement or clone the graph back merely to solve this sequencing problem.

On initialization or preparation failure, use the existing explicit error path. No automatic retry loop or silent JS-compute fallback. During experiments JS is the reference; after promotion there is one production compute path. If WASM loses, keep JS and remove the experiment instead of shipping unused dual engines.

### Build and test placement

- New: `crates/meeting-point/Cargo.toml`, Rust source and behavior tests; generated `crates/meeting-point/pkg/` stays ignored.
- New: a small `src/lib/meeting-search.ts` worker adapter and a narrow integration test for the real generated bindings.
- Change: `src/scripts/meeting-point.worker.ts` for initialization, FIFO execution, solve/rank composition and unique buffer transfer.
- Change: `package.json` to give each crate a named build command and aggregate them under `build:wasm`.
- Change as needed: `Cargo.lock`, a routing-package optimization override in the workspace manifest, and the CI ordering described below.
- Migrate callers/tests of the replaced JS search export. Keep graph types, parsing, ranking and route helpers in `meeting-point.ts`; remove obsolete search implementation/exports from production only after parity succeeds. The old implementation may exist as an explicitly benchmark-only reference during comparison, not a shipped compatibility shim.
- Keep `MeetingPoint`, playback and renderer contracts unchanged unless a concrete integration failure requires a caller change.

Follow the existing `wasm-pack --target web --no-pack` and content-hashed client-asset pattern. Verify this also works when imported from a module worker: correct WASM MIME type, worker-relative asset URLs, CSP, generated typings, and no accidental SSR import. Do not assume the existing page-script integration proves the worker case. [R7] [P15]

CI currently runs JS tests before generating WASM. If binding integration tests import generated assets, move the aggregate WASM build before those tests and the type check; add the routing crate's Rust test command. Do not duplicate generated sources under `src/` to avoid that dependency. [R9]

## 4. Renderer design, conditional on profiling

### Why not switch immediately to a stateless shader?

The existing trail is an accumulation raster. Each pending range is painted source-by-source, and later draws overwrite earlier source colors. Range boundaries also depend on playback samples and budgeted catch-up. [R5] [INFERENCE] A full per-origin redraw, a nearest-origin shader, or a "latest distance wins" shader is not automatically equivalent; normal playback and a full seek rebuild may also have different overlap history. Verify this with recorded batches rather than assuming pixel parity.

First record ordered draw batches from the reference renderer and test their replay. Preserve background, roads, trail, routes, candidate markers, origin markers, pings/halo and scale order. Do not silently redefine overlap semantics as part of a performance change.

### Preferred first GPU experiment: direct WebGL2 streets/trails

- Keep React controls, map interaction, clock, CPU trees and hit testing.
- Upload static world-space segment geometry once per network; allow `f32` for render-only coordinates, never for routing/ranking/hit-test truth.
- Upload per-output edge ordering/buckets once. Use instanced quads and batched range draws rather than JS calls for individual edges.
- Use an accumulation framebuffer for the trail, following ordered reference batches. Rewind/output/theme/selection changes must clear, stage or rebuild coherently; camera movement composites cached layers.
- Retain Canvas2D for routes, labels, markers and pings in the first experiment. A transparent overlay keeps those existing semantics and avoids introducing text rendering/atlases at the same time. The GPU base is not an additional accessible or pointer-interactive map.
- Create a new canvas for the GPU layer; do not try to reuse a canvas already initialized as 2D. Respect CSS size, DPR, clipping, viewport transform and the existing raster scale.
- Handle context creation failure and loss without changing results or timeline state. Recreate GPU resources from CPU-owned data. For production, retaining the real Canvas2D renderer as an unsupported-GPU path is justified compatibility, not fake output; it requires two tested adapters, not a third `wgpu` engine.
- Dispose buffers, textures, framebuffers, programs, observers and scheduled work on region change/unmount.

A recorded-batch parity check does not by itself prove live playback's batch boundaries are identical at different frame rates. Production promotion must resolve that explicitly. Default: preserve current semantics; if backend-independent canonical overlap behavior is desirable, obtain approval for that visual behavior change first. If parity cannot be achieved within the experiment, stop the renderer cutover.

Use a small street-layer interface only once the reference and WebGL2 implementations justify it: ordered range application, reset/rebuild, camera compositing, palette update and disposal. Avoid moving the whole map into a generic graphics engine.

### Why defer `wgpu` and OffscreenCanvas?

`wgpu` is appropriate if a common Rust rendering API, native deployment, or WebGPU-specific work becomes a requirement. Here it adds shader translation/backend configuration and another capability matrix without an established need. It is not inherently faster than direct WebGL2 issuing equivalent draws. If revisited, evaluate a pinned version, explicitly selected `webgpu`/`webgl` features, a lowest-common rendering capability set, and separate adapter/device/context-loss paths. Do not ship all backends merely because a crate supports them. [P8] [P9]

OffscreenCanvas remains a possible smaller response to main-thread drawing pressure. Prototype it separately from WebGL2, with a dedicated renderer worker rather than blocking frame delivery behind synchronous routing in the same worker. Canvas ownership, resize/pointer messages and shutdown still need design and measurement. No shared-memory/thread configuration is needed merely to transfer an OffscreenCanvas. [P14]

## 5. Implementation sequence and exit gates

All numeric gates below are proposed engineering targets, not measured results or external requirements.

### Phase 0: reproducible browser baseline

- Exercise the current production build and an allocation-reduced JS heap variant, including removal of the per-pop tuple where it improves measured behavior. Keep the variant out of production until it wins.
- Use fixed local OSM-derived fixtures: SF plus a non-SF graph and deterministic small adversarial graphs. Retain attribution/provenance; do not benchmark by repeatedly querying public providers.
- Test 2/4/8/16 starts, both objectives, duplicate/coincident starts, and origin edits/cancellation. Use the same fixture, browser/device, build settings and operation sequence for each engine.
- Separate cold first usable result, warm uncached search, cached objective rerank, export/copy/transfer, map-preparation readiness, and steady playback/pan/seek timings.
- Record compressed JS/WASM bytes, compilation/preparation time, peak/retained memory and repeated load/cancel cycles. Use two warmups followed by at least twenty measured warm iterations; report median and p95 with raw samples. Do not add independently measured medians into a fake total.
- Include Chromium at normal and 4× CPU settings plus real Firefox and Safari/WebKit-family browser checks where available. CPU throttling does not emulate a weaker GPU, and automated WebKit is not proof of actual Safari GPU support. Record unavailable hardware/browser coverage as a limitation.

Exit: repeatable behavior traces and stage-separated browser measurements. The earlier Bun table is not a substitute for this baseline.

### Phase 1: Rust kernel and ownership prototype

- Implement the custom heap, CSR and complete Dijkstra batch with safe owned outputs and minimal bindings.
- Prove exact distances and parents against the JS reference on deterministic cases and SF origin groups; ranking and collisions must remain identical.
- Prove real worker initialization and output transfer, including slow/failed initialization and `attach` immediately followed by search.
- Compare size- and speed-oriented routing builds without changing the audio crate's profile.

Exit: parity and ownership checks pass; browser timings include module startup and all copies. A fast Rust-native executable or Bun-only result does not pass this gate.

### Phase 2: promote only the winning compute implementation

Proposed gate: at least 20% and 10 ms improvement in median warm uncached worker-to-UI search for both four- and sixteen-origin fixtures against the best JS baseline, with p95 no worse. Cold first-result and cached-rerank medians must not regress by more than 5% under the controlled setup. Record memory/payload cost and explain any material increase before promotion.

If the gate fails, stop and retain JS; do not compensate by changing the task, dropping parity checks or presenting an inner-loop number as the result.

If it passes, make the clean production cutover, migrate affected tests/callers, delete losing experimental code, update build/docs, and verify the affected Cloudflare preview for the pushed commit. Do not bundle a GPU rewrite into this change.

### Phase 3: traversal preparation, only if still material

Use the new browser trace to decide whether to move the existing JS bucket builder into the retained worker or port it alongside the Rust graph. Compare both against the current chunked main-thread preparation.

Keep original edge IDs/order, absolute-distance bucket bounds, unreachable exclusion, candidate cutoffs and rewind behavior. A Rust builder would need original edge endpoint information retained once, not copied on each search. Budget output packing/transfer explicitly. Doing buckets before the result reply can delay the results list even if it improves main-thread responsiveness; measure first-result and animation-ready times separately.

Exit: a demonstrated responsiveness/readiness gain without a material first-result or memory regression. Otherwise keep the current builder.

### Phase 4: conditional renderer experiment

Start only with evidence that Canvas2D rendering remains a meaningful bottleneck. Compare direct WebGL2 or a separate OffscreenCanvas experiment, not both simultaneously.

For WebGL2, proposed promotion gate: at least 25% improvement in p95 main-thread renderer work on the heavy cases, with frame pacing/dropped frames no worse, acceptable memory/startup cost, and the visual/lifecycle checks below passing. If the baseline is already smooth or the GPU becomes the bottleneck, do not ship a rewrite merely because command submission is faster.

Measure actual frame intervals and browser rendering/GPU traces. CPU time to enqueue GL commands is not GPU completion time. If supported, asynchronous disjoint timer queries can supplement profiling; do not insert `gl.finish()` or pixel readbacks into normal performance measurements.

`wgpu` is a separate future decision, not an automatic next phase.

## 6. Verification and failure matrix

| Area                 | Required observable evidence                                                                                                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Routing              | Exact complete distances/parents; fractional and equal-weight ties; disconnected graphs; duplicate starts; invalid indices; unchanged ten-candidate ranking/separation and contacts.         |
| Ownership            | Owned exports survive later solve/allocation/growth; one unique transfer per backing buffer; nonzero expected views on receipt; no per-row copying or retained stale WASM views.             |
| Startup/cancellation | Delayed/failed module initialization; queued attach/search; busy edit termination; region switches; stale reply rejection; a later valid search still succeeds.                              |
| Reuse                | Idle worker and prepared graph retained; completed trees reused for objective changes; no graph repack or hidden search on cached rerank.                                                    |
| Playback             | Stable snapshots/traces at start, pair-contact windows, traversal end, intermediate final reveal and completion; reverse seek, replay, pause, speed and lower/higher candidate selection.    |
| Visuals              | Light/dark themes, reduced motion, multiple DPRs, pan/zoom/fit, opaque overlap order, label/marker stacking, visible-opacity hit threshold, no duplicate accessible canvas.                  |
| Graphics lifecycle   | Context unavailable/lost/restored, resize during preparation, network/output replacement, unmount and resource disposal; routing results remain intact.                                      |
| Packaging            | Both crates built before binding-dependent tests/typecheck; content-hashed WASM loads from a module worker with correct MIME/CSP; no server-side WASM import or generated source checked in. |

Use existing behavior tests as the starting contract, not source-text or forwarding tests. Add permanent cases only for meaningful new numeric, ownership or lifecycle failures. Rust-native tests do not replace browser/WASM seam checks. [R8]

## 7. Scope and remaining decisions

Recommended defaults for the first experiment: routing-only Rust, one retained worker, safe bulk-copy exports, single-threaded WASM, unchanged Canvas2D UI, no provider changes, and no `wgpu` dependency. These are proposals, not implemented features.

Before implementation, confirm the proposed promotion thresholds and the browser/device coverage available for the benchmark. No paid provider, API key, native port, shared-memory headers or public-service traffic is required for the local experiments.

Before any GPU production cutover, resolve overlap-history parity and the tested unsupported-GPU behavior. A desire to replace legacy history-dependent colors with a canonical stateless flood is a product/visual decision, not a free optimization.

Planning deliverable: this document only. Implementing the phases is subsequent work. Each permanent winning change follows the repository's verify → commit/push → PR → commit-matched Cloudflare preview workflow; no localhost-only handoff.

## Sources

Repository links are pinned to the inspected baseline, so later edits do not silently change the cited contracts.

- [R1] [Graph, Dijkstra, ranking and route contracts](https://github.com/baladithyab/baladithyab.github.io/blob/12b181e93f77928fb6c6662a7a1cac1f78e573e9/src/lib/meeting-point.ts#L1-L243).
- [R2] [Retained worker, loading, attach, search and transfer](https://github.com/baladithyab/baladithyab.github.io/blob/12b181e93f77928fb6c6662a7a1cac1f78e573e9/src/scripts/meeting-point.worker.ts#L14-L88).
- [R3] [Parent session identity, cancellation and completed-tree reuse](https://github.com/baladithyab/baladithyab.github.io/blob/12b181e93f77928fb6c6662a7a1cac1f78e573e9/src/components/MeetingPoint.tsx#L359-L535); [message protocol](https://github.com/baladithyab/baladithyab.github.io/blob/12b181e93f77928fb6c6662a7a1cac1f78e573e9/src/lib/meeting-session.ts).
- [R4] [Playback state and commands](https://github.com/baladithyab/baladithyab.github.io/blob/12b181e93f77928fb6c6662a7a1cac1f78e573e9/src/components/MeetingPlayback.tsx).
- [R5] [Raster accumulation, staging, render order and interactions](https://github.com/baladithyab/baladithyab.github.io/blob/12b181e93f77928fb6c6662a7a1cac1f78e573e9/src/components/MeetingMap.tsx#L116-L977); [traversal buckets](https://github.com/baladithyab/baladithyab.github.io/blob/12b181e93f77928fb6c6662a7a1cac1f78e573e9/src/lib/meeting-map-traversal.ts).
- [R6] [Cargo workspace and release settings](https://github.com/baladithyab/baladithyab.github.io/blob/12b181e93f77928fb6c6662a7a1cac1f78e573e9/Cargo.toml); [audio crate manifest](https://github.com/baladithyab/baladithyab.github.io/blob/12b181e93f77928fb6c6662a7a1cac1f78e573e9/crates/energy-ring/Cargo.toml).
- [R7] [Existing Rust/WASM build and compatibility findings](https://github.com/baladithyab/baladithyab.github.io/blob/12b181e93f77928fb6c6662a7a1cac1f78e573e9/docs/RUST_WASM.md#L14-L111).
- [R8] [Search tests](https://github.com/baladithyab/baladithyab.github.io/blob/12b181e93f77928fb6c6662a7a1cac1f78e573e9/src/lib/meeting-point.test.ts), [collision tests](https://github.com/baladithyab/baladithyab.github.io/blob/12b181e93f77928fb6c6662a7a1cac1f78e573e9/src/lib/meeting-collisions.test.ts), [traversal tests](https://github.com/baladithyab/baladithyab.github.io/blob/12b181e93f77928fb6c6662a7a1cac1f78e573e9/src/lib/meeting-map-traversal.test.ts).
- [R9] [Current test/build/typecheck CI ordering](https://github.com/baladithyab/baladithyab.github.io/blob/12b181e93f77928fb6c6662a7a1cac1f78e573e9/.github/workflows/cloudflare-deploy.yml#L81-L90); [build scripts](https://github.com/baladithyab/baladithyab.github.io/blob/12b181e93f77928fb6c6662a7a1cac1f78e573e9/package.json#L12-L29).

Primary platform documentation, accessed 2026-11-12:

- [P1] [wasm-bindgen numeric slices and input/copy-back behavior](https://wasm-bindgen.github.io/wasm-bindgen/reference/types/number-slices.html).
- [P2] [wasm-bindgen boxed numeric slices and output copying](https://wasm-bindgen.github.io/wasm-bindgen/reference/types/boxed-number-slices.html).
- [P3] [WebAssembly JS API: memory buffer creation and refresh](https://webassembly.github.io/spec/js-api/index.html#memories).
- [P4] [HTML structured serialization with transfer](https://html.spec.whatwg.org/multipage/structured-data.html#structuredserializewithtransfer).
- [P5] [Rust wasm32-unknown-unknown target](https://doc.rust-lang.org/rustc/platform-support/wasm32-unknown-unknown.html).
- [P6] [SharedArrayBuffer security and shared WASM memory](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer#security_requirements).
- [P7] [Cargo optimization settings and package overrides](https://doc.rust-lang.org/cargo/reference/profiles.html#overrides).
- [P8] [wgpu 30.0.1 capabilities and backend features](https://docs.rs/wgpu/30.0.1/wgpu/). Version pinned for this research; recheck before adopting it.
- [P9] [WebGPU adapter acquisition](https://www.w3.org/TR/webgpu/#dom-gpu-requestadapter) and [device loss](https://www.w3.org/TR/webgpu/#dom-gpudevice-lost).
- [P10] [Khronos WebGL2 specification](https://registry.khronos.org/webgl/specs/latest/2.0/). Living Editor's Draft; do not infer browser coverage from the specification.
- [P11] [WGSL scalar types](https://gpuweb.github.io/gpuweb/wgsl/#scalar-types). Distinguish abstract compile-time types from runtime data types.
- [P12] [WebGL line-width capability range](https://developer.mozilla.org/en-US/docs/Web/API/WebGLRenderingContext/lineWidth).
- [P13] [WebGL context-loss cases](https://developer.mozilla.org/en-US/docs/Web/API/WebGLRenderingContext/isContextLost).
- [P14] [OffscreenCanvas transfer and initialization restrictions](https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/transferControlToOffscreen).
- [P15] [Streaming WASM instantiation, MIME and CSP](https://developer.mozilla.org/en-US/docs/WebAssembly/Reference/JavaScript_interface/instantiateStreaming_static).

Reference-index limitation: the project's XERJ registry marks this checkout `unindexed-tool-bug`; its pinned Photon peer does not cover graphics/routing. This plan therefore uses verified live repository source and the first-party sources above, not an assumed current source index or copied peer implementation.

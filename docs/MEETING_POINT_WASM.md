# Meeting-point acceleration: research and implementation plan

Status: the evaluated Rust/WASM prototype passed the exercised correctness/ownership checks but **failed the frozen end-to-end promotion gate** and was removed from active code/builds. Retain the existing production JavaScript search; neither Rust nor the scalar comparison baseline is promoted. Canvas2D is unchanged. The experiment and conditional no-go decisions are recorded below.

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

## 3. Evaluated Rust/WASM design (archived, not shipped)

This section records the contract implemented in [prototype checkpoint `874c039`](https://github.com/baladithyab/baladithyab.github.io/commit/874c039), not current setup instructions. The crate, adapter, binding tests and meeting-specific build/CI wiring were removed after the failed gate; the source and contract remain in the Phase 1 evidence archive.

### Responsibilities

The prototype used a separate `crates/meeting-point` compute crate, independent of `energy-ring`, `web-sys` graphics APIs and `wgpu`.

Rust owns:

- Retained CSR adjacency with `u32` indices and `f64` weights.
- A custom heap matching the existing comparison/tie behavior, with one scratch allocation retained across origins and later solves.
- Complete Dijkstra trees for a requested origin batch through a mutable prepared session (`Graph::solve(&mut self, ...)`); the serial worker does not need a concurrent immutable solve API.
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
7. Consuming output methods must move each owned distance/parent block exactly once and reject a second take. Free the batch in `finally` except after a terminal trap; no cloned getters, per-row copies or extra serialization. Allocate flat output blocks directly with capacity equal to length; inspect generated glue for one copy and free per output.
8. Replacing a prepared Rust session frees its owned object. Worker termination remains the actual cancellation mechanism; no claim of cooperative cancellation while synchronous Rust is executing.

The expected adapter shape is asynchronous preparation followed by a synchronous batch solve returning owned JS trees and their unique transferables. Keep raw pointers and unsafe borrowed memory views out of the initial public surface. Exact generated binding names can be chosen during implementation; ownership and output layout are the contract.

Use checked arithmetic before allocating `N * V` arrays. Do not silently cap the group, truncate results or downcast routing distances to `f32`. A memory failure must produce a clear error, not fabricated results.

### Preserve message ordering during asynchronous startup

Today `attach` is synchronous and emits no success reply; the immediately following search depends on that. Simply adding `await initWasm()` to an independent handler creates an ordering hazard. [R2] [R3]

Serialize incoming worker requests through one private FIFO promise chain over complete load/attach/search handlers, including graph loading. Each handler completes initialization/preparation before the next queued request runs. Keep error handling from leaving a poisoned queue, retain the current search IDs, and preserve the parent's termination/session-identity guards. The frozen r4 contract records the supported main flow: search requires ready data; load/region retry creates a new worker; supported attach is immediately followed by search. Do not preserve unreachable stale-load-overwrites-attach races by moving fetch outside the FIFO, add an `attached` acknowledgement, or clone the graph back merely to solve sequencing.

Cache the boot outcome without an unhandled early rejection, while surfacing initialization/preparation failures through the existing explicit error reply. Ordinary returned Rust errors leave the session usable. A `WebAssembly.RuntimeError` is module-wide terminal: retain the original error, null active handles, and make no further native calls, including `free`. Strongly quarantine live/trapped graph and batch wrappers so wasm-bindgen's `FinalizationRegistry` cannot call native destructors on the poisoned instance; worker termination releases the realm. Main-thread failure already terminates the session, and a later search creates a worker then sends attach+search; no retry shim is required.

No automatic retry loop or silent JS-compute fallback. During experiments JS is the reference; after promotion there must be one production compute path. The no-go exit retained JS and removed the experiment instead of shipping unused dual engines. Exercised contract checks and untested failure limitations are recorded in Phase 1.

### Build and test placement

- New: `crates/meeting-point/Cargo.toml`, Rust source and behavior tests; generated `crates/meeting-point/pkg/` stays ignored.
- New: a small `src/lib/meeting-search.ts` worker adapter and a narrow integration test for the real generated bindings.
- Change: `src/scripts/meeting-point.worker.ts` for initialization, FIFO execution, solve/rank composition and unique buffer transfer.
- Change: `package.json` to give each crate a named build command and aggregate them under `build:wasm`.
- Change as needed: `Cargo.lock`, a routing-package optimization override in the workspace manifest, and the CI ordering described below.
- Migrate callers/tests of the replaced JS search export. Keep graph types, parsing, ranking and route helpers in `meeting-point.ts`; remove obsolete search implementation/exports from production only after parity succeeds. The old implementation may exist as an explicitly benchmark-only reference during comparison, not a shipped compatibility shim.
- Keep `MeetingPoint`, playback and renderer contracts unchanged unless a concrete integration failure requires a caller change.

Follow the existing `wasm-pack --target web --no-pack` and content-hashed client-asset pattern. Verify this also works when imported from a module worker: correct WASM MIME type, worker-relative asset URLs, CSP, generated typings, and no accidental SSR import. Do not assume the existing page-script integration proves the worker case. [R7] [P15]

At the inspected baseline, CI ran JS tests before generating WASM. The prototype moved aggregate WASM generation before binding-dependent tests/type checking and added the routing crate's native tests. That meeting-specific wiring was removed with the rejected crate; current CI retains the audio build. Generated packages were not duplicated under `src/`. [R9]

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

The compute decision and prototype contracts were frozen as **r4**, retained in the `frozenContract.text` field of [`benchmarks/meeting-point-phase1.json.gz`](benchmarks/meeting-point-phase1.json.gz). Numeric gates are engineering acceptance criteria, not measured results or external requirements; the original phased plan and its disposition remain below.

### Phase 0: reproducible browser baseline

- Exercise the current production build and an allocation-reduced JS heap variant, including removal of the per-pop tuple where it improves measured behavior. Keep the variant out of production until it wins.
- Use fixed local OSM-derived fixtures: SF plus a non-SF graph and deterministic small adversarial graphs. Retain attribution/provenance; do not benchmark by repeatedly querying public providers.
- Test 2/4/8/16 starts, both objectives, duplicate/coincident starts, and origin edits/cancellation. Use the same fixture, browser/device, build settings and operation sequence for each engine.
- Separate cold first usable result, warm uncached search, cached objective rerank, export/copy/transfer, map-preparation readiness, and steady playback/pan/seek timings.
- Record compressed JS/WASM bytes, compilation/preparation time, peak/retained memory and repeated load/cancel cycles. Use two warmups followed by at least twenty measured warm iterations; report median and p95 with raw samples. Do not add independently measured medians into a fake total.
- Include Chromium at normal and 4× CPU settings plus real Firefox and Safari/WebKit-family browser checks where available. CPU throttling does not emulate a weaker GPU, and automated WebKit is not proof of actual Safari GPU support. Record unavailable hardware/browser coverage as a limitation.

Exit: repeatable behavior traces and stage-separated browser measurements. The earlier Bun table is not a substitute for this baseline.

#### Recorded numerical evidence (2026-11-12)

The local raw reports `C:/Users/bbala_n314ugx/AppData/Local/Temp/meeting-sf-baseline.json` and `meeting-west-oakland-baseline.json` (same directory) both report `status: passed`. Each contains **1,200 measured rows across 60 engine cases**: two warmups then twenty measured samples for spread groups of 2/4/8/16 and coincident-4, both `fair` and `total`, and `current` versus allocation-reduced `scalar` JavaScript. Coverage is one fresh launch each of Chromium normal, Chromium `cpu4`, and Firefox normal; these are not pooled promotion samples. Reports retain per-case `raw` samples and summaries. The owner also recorded **40 passing correctness tests** and two passing filtered Chromium smoke launches (`meeting-filtered-smoke.json`); those smoke launches cover only groups 4/16 and `fair`, not the full matrix.

Commands reproducing the recorded numerical configurations, from the repository root in Bash (`$TEMP` is the report directory):

```sh
node scripts/meeting-bench.mjs --out "$TEMP/meeting-sf-baseline.json"
node scripts/meeting-bench.mjs --fixture scripts/meeting-bench/fixtures/west-oakland.json --out "$TEMP/meeting-west-oakland-baseline.json"
node scripts/meeting-bench.mjs --smoke --browser chromium --profile baseline --groups 4,16 --objectives fair --runs 2 --out "$TEMP/meeting-filtered-smoke.json"
```

The baseline commands use the recorded defaults: seed 2119, twenty samples, two warmups, both engines/objectives and all five groups. The smoke command uses three measured samples per case and is never promotion evidence. The recorded host was Windows x64, Ryzen 7 7700X, Node 24.15.0, Playwright 1.65.0 and Vite 8.3.6. Chromium `cpu4` is **page-only CDP throttling**: worker CPU throttling is unverified, and it does not emulate weak/mobile GPU hardware. Firefox CPU throttling was unavailable; no Safari/WebKit binary was available.

Both fixtures are fully connected: bundled SF has **105,016 nodes / 144,385 edges**; West Oakland has **100 nodes / 114 edges / 15 meeting places**. West Oakland is a small neighborhood fixture, not citywide coverage or a disconnected-graph test. The Oakland live capture returned **HTTP 406 and was not retried**; the replacement is the pinned official OSMnx `West-Oakland.osm.bz2` snapshot at commit `5f3b46f048f9f0a693702cea5f29f2eaad840204`. Its snapshot date is unknown. [Fixture provenance and normalization](../scripts/meeting-bench/fixtures/README.md) retain © OpenStreetMap contributors, ODbL 1.0 attribution/share-alike/database-access obligations where applicable; OSMnx's MIT software license does not relicense OSM data. These commands use local fixtures, not live provider queries.

SF Chromium-normal `spread-4` / `spread-16` results from `runs[0].results.cases`, metric `workerToMainSearchMs` (milliseconds, rounded to two decimals):

| Starts | Objective | Current median | Scalar median | Current p95 | Scalar p95 |
| -----: | --------- | -------------: | ------------: | ----------: | ---------: |
|      4 | fair      |          82.70 |         78.85 |       87.80 |      82.20 |
|      4 | total     |          79.85 |         75.25 |       85.80 |      80.10 |
|     16 | fair      |         333.45 |        324.30 |      380.80 |     391.40 |
|     16 | total     |         349.90 |        336.45 |      395.00 |     377.20 |

These are **numerical worker-to-main timings, not complete worker-to-UI latency or INP**. Scalar's small numerical median gains do not establish the promotion gate; sixteen-start `fair` p95 is worse. West Oakland's submillisecond numerical readings, including zeros, are timer-quantized, not proof of zero latency. The best single JS comparison baseline is selected from the corrected UI evidence below, not this numerical table. No Rust/WASM speedup or GPU acceleration is established.

#### Corrected real-UI evidence and frozen JS baseline (2026-11-12)

The authoritative UI reports are `meeting-ui-sf-placement-baseline.json` and `meeting-ui-west-oakland-placement-baseline.json` in `C:/Users/bbala_n314ugx/AppData/Local/Temp/`. Both report `status: passed`, `contract: meeting-ui-bench r4`, `phase0Eligible: true`, and `promotionEligible: false`. They supersede the earlier named-place-placement UI reports. Seeded placement samples **all real road nodes**, not just named meeting candidates; duplicate pixels/overlays are skipped, production snapping chooses the posted origins, and targets are checked within 50 m. This permits sixteen starts even on the fifteen-meeting-place Oakland fixture.

Each primary report covers `current` and `scalar`, groups **4/16**, both **fair/total**, **two warmups then twenty measured warm samples per case**, twenty cached opposite-objective reranks per case, **one fresh warm launch per engine**, and **twenty cold samples per engine**, each cold sample in a fresh browser process. Chromium was 158.0.8127.18, unthrottled, on the Windows/Ryzen host recorded above, viewport 1280×1100 at DPR 1. Raw observations remain under `runs[0].warm` and `.cold`; summaries and comparisons are separate. Each primary report's consistency check passed across 266 keys. Their promotion gate is explicitly `not-eligible` for `warm-samples` and `warm-launches`, not a performance pass.

Reproduce the recorded configurations from the repository root; these commands use only local fixtures and block non-local requests:

```sh
node scripts/meeting-ui-bench.mjs --engine current,scalar --browser chromium --profile baseline --groups 4,16 --samples 20 --cold-samples 20 --runs 1 --seed 2119 --out "$TEMP/meeting-ui-sf-placement-baseline.json"
node scripts/meeting-ui-bench.mjs --engine current,scalar --fixture scripts/meeting-bench/fixtures/west-oakland.json --browser chromium --profile baseline --groups 4,16 --samples 20 --cold-samples 20 --runs 1 --seed 2119 --out "$TEMP/meeting-ui-west-oakland-placement-baseline.json"
node scripts/meeting-ui-bench.mjs --smoke --engine current --browser firefox --profile baseline --groups 4,16 --samples 1 --cold-samples 1 --runs 1 --seed 2119 --out "$TEMP/meeting-ui-firefox-smoke.json"
node scripts/meeting-ui-bench.mjs --smoke --engine current --browser chromium --profile cpu4 --groups 4,16 --samples 1 --cold-samples 1 --runs 1 --seed 2119 --out "$TEMP/meeting-ui-cpu4-smoke.json"
```

Warm uncached **Find click → committed ranked-list next frame** (`clickToFrameMs`), from `runs[0].comparisons[0].groups[].warm`, milliseconds:

| Fixture | Starts | Objective | Current median | Scalar median | Current p95 | Scalar p95 |
| ------- | -----: | --------- | -------------: | ------------: | ----------: | ---------: |
| SF      |      4 | fair      |          88.50 |         84.85 |      107.40 |      99.40 |
| SF      |      4 | total     |          84.05 |         87.30 |       98.10 |     102.60 |
| SF      |     16 | fair      |         350.20 |        346.95 |      383.50 |     570.10 |
| SF      |     16 | total     |         347.30 |        323.15 |      375.60 |     403.40 |
| Oakland |      4 | fair      |          28.25 |         29.25 |       29.50 |      30.20 |
| Oakland |      4 | total     |          29.35 |         28.90 |       29.80 |      30.20 |
| Oakland |     16 | fair      |          30.65 |         30.40 |       31.70 |      31.50 |
| Oakland |     16 | total     |          30.35 |         29.70 |       32.50 |      31.50 |

**Frozen selection: scalar.** The r4 rule is the equal-weight geometric mean of the four primary SF UI-case medians, retaining current if the aggregate difference is at most 1%. Using the unrounded comparison values gives current **173.43 ms**, scalar **169.76 ms**: `1 - (product(scalarMedian / currentMedian))^(1/4)` is approximately **2.12%**. This selects one baseline before any Rust timing; no per-case minimum or post-Rust reselection is allowed. It is **not a production promotion**: scalar's p95 is worse in three SF cases, most median gains are small, and 4/total regresses. Remeasure scalar alongside any WASM candidate with the stronger Phase 2 sampling and guards.

Cold and cached measurements are actual UI observations, not inferred from worker timings:

- SF cold navigation-to-first-results-frame medians: **975.75 / 978.55 ms** (current/scalar; +0.29%). Navigation-to-Find-enabled: **470.15 / 465.70 ms**; first-search click-to-frame: **94.50 / 91.60 ms**. The separately recorded Find-enabled-to-click automation gap is **410.90 / 411.20 ms**. Do not sum independent medians or let this gap hide startup regressions.
- Oakland cold navigation-to-first-results-frame: **262.05 / 268.55 ms** (+2.48%); navigation-to-Find-enabled **136.95 / 139.10 ms**, first-search click-to-frame **26.05 / 25.70 ms**. Cold uses the production default preset origins, arbitrary when snapped onto a non-SF fixture; groups 4/16 apply only to warm/cached runs.
- SF cached opposite-objective click-to-frame medians, in 4/fair, 4/total, 16/fair, 16/total source-case order: **12.30 / 12.90**, **12.60 / 12.15**, **17.70 / 18.15**, **16.15 / 15.75 ms**. These paths assert no worker posts or worker creation. Oakland's cached 4/fair case regresses **10.29%** (10.20 → 11.25 ms), so coverage controls are not uniformly non-regressing.

Map readiness is recorded separately from result display. SF warm `preparationReadyMs` medians from result commit are approximately **22–23 ms** for four starts and **70–72 ms** for sixteen across both engines/objectives. First playback advance medians are **91–95 ms** and **137–142 ms**, respectively; the latter observes a nonzero slider value after at least 40 ms of 1× animation clock. Preparation timing exists only if the “Preparing the animated road layer” status rendered: scalar SF 4/fair has 18/20 observations, and Oakland has none, **not zero-cost preparation**. Oakland playback advance is measured in all warm cases, with medians approximately **64 ms**.

The interaction summaries contain playback, backward/forward seek, pan and fit windows, one per engine/group/objective/launch, not twenty independent interaction trials. SF current's sixteen-start fair/total playback frame-interval p95 is **16.8 / 16.7 ms** over roughly eight-second windows; forward seek takes **2408.3 / 1609.0 ms**, with **2246.4 / 1494.3 ms** of aggregate production frame-callback CPU and **19 / 14** long tasks. These forward-seek rebuilds already show severe render pressure despite steady playback intervals. Backward seek, pan and fit are recorded too; short windows can have no frame-interval samples.

Both smoke reports passed, but are **neither Phase-0-eligible nor promotion-eligible**: only current, one measured sample per case and one cold sample, one launch. Firefox **159.0** exercises both groups/objectives, playback/seek/pan/fit and cancellation/recovery; it is compatibility smoke, **not speed evidence**, and its Long Tasks API data is unavailable. Chromium CPU4's sixteen-start fair/total playback frame-interval p95 is **183.4 / 200.0 ms**, and forward seek takes **12862.0 / 14643.7 ms** with **81 / 88** long tasks. This is **page-only CDP throttling**; worker throttling is unverified and no weak-GPU/mobile emulation is claimed. Severe seek/CPU4 pressure warrants later traversal/raster profiling under Phases 3–4, **not a GPU decision yet**.

SF current/scalar cancellation records show a busy worker terminated, attach+search recovery on a new worker, one live worker after recovery and zero after unload according to Playwright worker enumeration. Worker counts are lifecycle evidence, **not worker/process retained-memory measurements**.

Limitations: this is a standalone Vite/Tailwind page using the real production component, CSS and worker (or benchmark scalar replacement), client-rendered with `createRoot`, not deployed Astro SSR/hydration. Site chrome and the externally hosted font are excluded; bundle sizes only approximate deployment. Instrumentation wraps Worker/rAF and DOM observation. Headless rAF timestamps are not compositor presentation, INP or GPU completion; frame-callback CPU measures Canvas2D command submission. Playback/seek/pan/fit require the canvas fully visible at start/settle; Find samples record visibility without enforcing it because the start list can scroll over the map. This DPR-1 viewport is not a DPR-2 desktop capture. Safari/WebKit coverage remains unavailable; these explicitly selected-browser runs do not add it, and automated WebKit would not prove Safari GPU behavior.

The separate memory-only run (`node scripts/meeting-ui-memory.mjs --out "$TEMP/meeting-ui-memory-baseline-r2.json"`) passed the real runner and captured live page/worker isolates in all four current/scalar cold/warm browser processes. Warm captures occur **before unload**, after cancellation/recovery with a final two-start result; individual process lifetime peaks include the earlier sixteen-start workloads. Explicit CDP GC succeeded. Warm post-GC used JS heap was **18.62/18.60 MiB** in the page and **12.45/12.45 MiB** in the worker (current/scalar); separately reported backing storage was **47.97 MiB** and **3.72 MiB**. These are instantaneous isolate observations, not leak diagnoses or WASM committed memory.

Windows readings were restricted to numeric PIDs returned by each owned browser's CDP process inventory. Warm renderer post-GC residency/lifetime peak was approximately **307/425 MiB** for current and **304/391 MiB** for scalar. Each process's peak includes startup/instrumentation; peaks are **not summed** or called a simultaneous browser peak. Exited workers are not covered. Explicit GC and process inspection invalidate timing-gate use of this run. Its GPU metadata reports **ANGLE SwiftShader/software canvas and compositing**, not hardware-GPU performance; headless render timings cannot establish a WebGL2/wgpu win on real GPU hardware.

A separate real-worker timing control inserted an **80 ms search-dispatch delay**, without replacing results. In three-sample four-start smoke cases, measured Find-to-frame medians increased **79.7 ms (fair)** and **91.5 ms (total)**; cached objective reranks still posted no worker search. This establishes end-to-end timing sensitivity, not promotion eligibility. The temporary control source is preserved in the evidence archive, not shipped.

[Complete raw evidence archive](benchmarks/meeting-point-phase0.json.gz) contains eight reports, original UTF-8 report hashes, twenty-four source fingerprints, the frozen scalar selection and timing-control source. Gzip SHA-256: `4b1a074e1e00f897b3a867b06e39261f804ece99ee86f3e8b03f89416a2dee04`. Inspect with Node's `gunzipSync`/`JSON.parse`; report values and raw samples are retained, not just this table.

**Phase 0 exit: verified within the stated coverage.** Correctness/coverage tests passed (40 + 39), affected-area TypeScript passed, `astro check` reported 0 errors/0 warnings/3 hints across 88 files, and `astro build` passed. A separate broad test-only typecheck exposed 21 diagnostics in six unchanged, unrelated files; it is not reported green or suppressed. Unavailable Safari/WebKit and hardware-GPU coverage remain explicit limitations. Rust/WASM startup, owned copies, payload and committed memory are Phase 1 work, not results of these JS-only reports.

### Phase 1: Rust kernel and ownership prototype

- Implement the r4 custom heap, CSR and mutable prepared Dijkstra session, reusing heap scratch across origins/calls and writing complete origin-major output blocks directly. Use checked sizes and fallible allocation without arbitrary caps; preserve strict-shorter/equal-priority behavior and independent earlier outputs.
- Prove exact distances and parents against the JS reference on deterministic cases and SF origin groups; ranking and collisions must remain identical.
- Prove real worker initialization and unique two-buffer output transfer, including slow/failed initialization, `attach` immediately followed by search, recoverable errors followed by valid work, owned exports surviving later solves/memory growth, and fatal-trap finalizer quarantine. Keep the prototype worker separate from production until promotion; source-reviewed trap handling is not an exercised trap test.
- Compare size- and speed-oriented routing builds without changing the audio crate's profile.

Exit: parity and ownership checks pass; browser timings include module startup and all copies. A fast Rust-native executable or Bun-only result does not pass this gate.

#### Exercised prototype, before promotion

- The archived `meeting-point` crate implemented safe CSR storage, reference heap ordering, reusable heap scratch and complete origin-major `f64` distance / `i32` parent blocks. A bounded refinement hoisted immutable graph borrows and row slices out of the search loop without changing the algorithm or public contract.
- Parent-run checks passed: **20 native Rust tests**, **24 tests against the real generated WASM bindings**, focused TypeScript checking, and Astro checking (**90 files, zero errors/warnings, three hints**). Tests cover exact SF trees, ranks and contacts; adversarial graphs and duplicate origins; invalid input followed by valid work; independent owned exports; memory growth; and checked output-capacity rejection without allocating the oversized output.
- Real Chromium 158 and Firefox 159 worker probes passed delayed/failed initialization, FIFO `attach`/search and load/search, recoverable request errors, explicit new-worker recovery, termination while pending, owned exports and transfer of exactly two unique ordinary buffers. Sender buffers were detached after delivery. The served WASM used `application/wasm` under a self-only script policy with `wasm-unsafe-eval`; the probe recorded no CSP violations or page errors. WebKit's matching installed browser was unavailable.
- Generated bindings were inspected: each consumed output performs one owned `.slice()` followed by release of its native vector. Fatal-`RuntimeError` wrapper quarantine received independent source review, **not an exercised runtime-trap test**. No unsafe physical-OOM/trap probe was introduced.

Recompressing the initial identical-kernel binaries with the benchmark's **Node 24.15.0 `node:zlib` (`1.3.1-e00f703`), gzip level 6** gives **34,417-byte WASM / 14,380-byte gzip** with `opt-level="s"`, versus **30,994 / 12,940 bytes** with meeting-crate-only `opt-level=3`; glue is **11,172 / 2,805 bytes** in both. These precede the borrow-hoisting refinement. Phase 2 asset gzip sizes use the same Node compressor/level. Archived `variants.*.wasmGzipBytes` were recorded with Bun 1.4.4's default compressor (14,506 / 13,025 / 13,246), not that Node runtime; keep those historical fields as recorded rather than comparing unlike compression settings. Both profile builds left audio WASM unchanged: **72,381 bytes**, SHA-256 `af54b1f0350b3b186d0dc4d6f97eca4540e566e0d91808362ef923cd1d85f299`. No workspace-wide release-profile change was used.

Three-sample UI runs were diagnostics only, not promotion evidence. The speed-oriented build was selected for the declared full comparison; the four acceptance cases, sample counts and thresholds below were not relaxed. The separate prototype worker was never promoted.

### Phase 2: promote only the winning compute implementation

Frozen r4 gate: on **SF four/sixteen starts × fair/total, unthrottled Chromium**, require at least **20% and 10 ms** lower median warm uncached Find-click-to-committed-ranked-list-next-frame latency against the frozen scalar JS baseline, with p95 no worse. Record worker dispatch-to-arrival separately and require no regression. Collect **at least 100 measured warm samples per case across at least three fresh launches** (after warmups); the twenty-sample Phase 0 reports cannot promote a candidate.

Cold navigation-to-first-result and cached opposite-objective rerank medians must each regress by no more than **5%**. Also guard cold **navigation-to-Find-enabled** and **first-search click-to-frame** medians individually at ≤5%, so driver scrolling/automation gaps cannot mask startup cost. Other origins/profiles and small Oakland are correctness/non-regression/coverage controls, not a requirement to invent a 10 ms saving on a submillisecond numerical graph. Record memory/payload cost and explain any material increase before promotion. Benchmark-only detailed native solve/input marshal, owned take/copy, ranking, collisions and actual committed-memory instrumentation must be excluded from production builds.

If the gate fails, stop and retain JS; do not compensate by changing the task, dropping parity checks or presenting an inner-loop number as the result.

If it passes, make the clean production cutover, migrate affected tests/callers, delete losing experimental code, update build/docs, and verify the affected Cloudflare preview for the pushed commit. Do not bundle a GPU rewrite into this change.

#### Measured compute decision: no-go (2026-11-12)

`meeting-wasm-ui-primary-hoisted.json` completed successfully as a benchmark, with **promotion-eligible coverage**: 102 measured warm samples per case across three fresh Chromium headless-shell launches, two warmups, and twenty cold samples per engine. Its comparison gate is **failed**, not passed. Same fixed SF fixture, seed 2119, both objectives, four/sixteen starts, and frozen scalar baseline; no threshold or workload was changed after seeing the results.

| Starts | Objective | JS median ms | WASM median ms | Saving ms | Saving % | JS p95 ms | WASM p95 ms |
| -----: | --------- | -----------: | -------------: | --------: | -------: | --------: | ----------: |
|      4 | fair      |        84.80 |          80.10 |      4.70 |     5.54 |     97.30 |       87.00 |
|      4 | total     |        85.25 |          80.45 |      4.80 |     5.63 |     99.70 |       87.50 |
|     16 | fair      |       308.45 |         277.55 |     30.90 |    10.02 |    346.80 |      311.20 |
|     16 | total     |       314.50 |         264.55 |     49.95 |    15.88 |    354.60 |      292.70 |

All four cases miss the required 20% median reduction; four-start cases also miss the 10 ms minimum. All warm p95 and worker-arrival checks pass, but that does not override the failed gates. Cold first-search click-to-frame rises from **87.70 to 99.75 ms (+13.74%)**, above the 5% limit. Sixteen-start fair-to-total cached reranking rises from **15.90 to 17.15 ms (+7.86%)**, also above 5%. Cold navigation-to-results (+0.49%) and navigation-to-Find-enabled (−0.46%) pass individually.

The final measured candidate WASM was **31,500 bytes / 13,152 bytes gzip**, in addition to its worker/glue; the worker bundle was **22,394 / 7,929 bytes**, versus scalar JS **16,377 / 6,021 bytes**. These are standalone Vite assets, not deployed Astro sizes. The losing crate, adapter, prototype worker, binding-specific tests and CI wiring were removed after preserving the raw report and prototype checkpoint. No unused alternative engine ships; the gate was not retuned.

Promotion eligibility now also checks the frozen SF **content hash**, default Chromium `baseline` profile and selected `scalar` first engine, not merely sample counts. Firefox, CPU4, another fixture or another first engine are controls, not promotable evidence. Phase 0 coverage remains separately classified. The archived primary run already has the required scope; this correction does not change its failed decision.

Durable evidence: [`benchmarks/meeting-point-phase1.json.gz`](benchmarks/meeting-point-phase1.json.gz), SHA-256 `1b60ec3b7a52dc3d22ed23577d9f753ab217805d09105b5bd1d6faffc94a8658`. It contains ten original report texts with hashes, the full frozen r4 contract, sixteen source snapshots, original/hoisted profile artifacts and exercised-check metadata. Source snapshots were taken after optional diagnostic corrections, not falsely labeled as the exact pre-correction harness. The measured WASM binary is retained as archival data, not a production package.

The measured speed build used `wasm-pack build crates/meeting-point --release --target web --no-pack -- --config 'profile.release.package.meeting-point.opt-level=3'`, followed by `node scripts/meeting-ui-bench.mjs --engine scalar,worker --worker scripts/meeting-bench/wasm.worker.ts --runs 3 --samples 34 --cold-samples 20 --browser chromium --profile baseline --out "$TEMP/meeting-wasm-ui-primary-hoisted.json"`. Reproduce against prototype checkpoint `874c039` and its lockfile/toolchain context, not by overlaying its old workspace lock onto newer unrelated labs. The archived source/binary data is not an application dependency.

### Phase 3: traversal preparation, only if still material

Use the new browser trace to decide whether to move the existing JS bucket builder into the retained worker or port it alongside the Rust graph. Compare both against the current chunked main-thread preparation.

Keep original edge IDs/order, absolute-distance bucket bounds, unreachable exclusion, candidate cutoffs and rewind behavior. A Rust builder would need original edge endpoint information retained once, not copied on each search. Budget output packing/transfer explicitly. Doing buckets before the result reply can delay the results list even if it improves main-thread responsiveness; measure first-result and animation-ready times separately.

Exit: a demonstrated responsiveness/readiness gain without a material first-result or memory regression. Otherwise keep the current builder.

Measured decision: **retain the cooperative main-thread builder**. Opt-in stage measurements separate projection/base roads from bucketing: warmed sixteen-start traversal takes **57.1–77.8 ms elapsed / 47.3–66.2 ms synchronous work**, across 161 generator resumes per build in this diagnostic. This is measurable readiness work, not the heavy seek repaint, and not a measured worker-offload regression.

A serial pre-reply worker build moves that work onto the first-results critical path. An asynchronous design retaining the existing main-owned complete trees needs additional distance retention/copying (sixteen SF distance rows alone are **13,442,048 bytes**) or a wider protocol/lifetime redesign. Those are design costs, not benchmarked regressions. With the Rust cutover rejected and no observed playback/seek long tasks in the control without Canvas/preparation profiling or CDP tracing, another backend/copy path is not justified by this evidence. No worker/Rust bucket prototype is claimed faster; weak/mobile hardware remains unmeasured.

### Phase 4: conditional renderer experiment

Start only with evidence that Canvas2D rendering remains a meaningful bottleneck. Compare direct WebGL2 or a separate OffscreenCanvas experiment, not both simultaneously.

For WebGL2, proposed promotion gate: at least 25% improvement in p95 main-thread renderer work on the heavy cases, with frame pacing/dropped frames no worse, acceptable memory/startup cost, and the visual/lifecycle checks below passing. If the baseline is already smooth or the GPU becomes the bottleneck, do not ship a rewrite merely because command submission is faster.

Measure actual frame intervals and browser rendering/GPU traces. CPU time to enqueue GL commands is not GPU completion time. If supported, asynchronous disjoint timer queries can supplement profiling; do not insert `gl.finish()` or pixel readbacks into normal performance measurements.

`wgpu` is a separate future decision, not an automatic next phase.

Measured decision: **retain Canvas2D; no WebGL2/OffscreenCanvas production rewrite**. Full Chromium's independent capability probe reports accelerated 2D canvas/compositing/rasterization and NVIDIA RTX 5090 D3D11. The opt-in diagnostic captured twenty finite interaction traces with **no reported data loss or limit/cleanup failures**; the earlier whole-launch and overly broad captures overflowed and are recorded as failed evidence, not reused for timing claims.

A supplemental hardware run **without Canvas/preparation profiling or CDP tracing** completed playback/seek/pan/fit for four/sixteen starts and both objectives. Worker/rAF wrappers, DOM observers and the long-task observer still run. Playback rAF p95 was **6.2 ms**, with zero reported playback/seek long tasks; sixteen-start forward seeks settled in **125.6 / 120.0 ms** (fair/total), with **106.8 / 109.2 ms** accumulated production frame-callback CPU. This single-launch smoke control is not a renderer promotion study, weak-device result, presentation timing or INP. It does not make the earlier software-rendered multi-second seeks a universal browser baseline.

Profiling itself is substantial: sixteen-start fair seek was **321.2 ms**, of which **298.2 ms** was frame-callback CPU; timed native `stroke`/`drawImage` calls account for **17.3 ms**. The residual includes millions of wrapped path calls, other native work and profiler overhead—not pure JS. Actual matching user-timing trace windows contain `RasterDecoderImpl` work on `CrGpuMain` and compositor events; nested/inclusive event durations are not GPU execution/completion time. Do not infer a WebGL speedup from submission alone.

Two complete heavy-case captures and their original hashes are archived in [`benchmarks/meeting-point-canvas-heavy-traces.json.gz`](benchmarks/meeting-point-canvas-heavy-traces.json.gz), SHA-256 `f107f5f36a96193ded9f74ecb29de424a126b95406c2e32f2a93c8bddd13104d`; the main Phase 1 archive retains the full diagnostic/control reports and trace analysis.

Independent source reviews agree that captured source-major run partitions can change the **settled** overlap colors, not merely catch-up frames. They disagree on whether a faster executor's timing-induced winner changes are acceptable; the counterexamples were source reasoning, not executed pixel tests. Keep the conservative frozen contract: do not silently canonicalize colors or call a smaller deadline-checked stroke chunk history-equivalent. Normal hardware playback is already smooth in the tested control, so the visual/lifecycle complexity of a new renderer is not justified here. This is a measured decision not to start that conditional prototype, not a claim that every device is fast or that WebGL/OffscreenCanvas was benchmarked and lost.

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

The archived experiment used routing-only Rust, one retained worker, safe bulk-copy exports and single-threaded WASM. Meeting-point production retains JS routing and unchanged Canvas2D. The merged base separately builds energy-ring and the Deep Brush WebGPU lab; this meeting-point experiment introduces no active Rust crate, provider change, meeting-specific `wgpu` dependency or shared-memory headers.

[Closeout evidence](benchmarks/meeting-point-closeout.json.gz), SHA-256 `49b9d02c529725892d5b8e0d4e2a87517375bdceca807f0cc1e1fd2000fe6192`, retains four original verification reports, normalized compression provenance and independent-review dispositions. Cleanup checks passed: 86 tests across five files, then 46 gate tests after the scope fix (overlapping coverage, not 132 distinct tests). The merged energy-ring/Deep Brush WASM build, Astro check (90 files, zero errors/warnings, three hints) and production build passed.

Final real-browser smokes cover JS/scalar numerical parity in Chromium/Firefox, current/scalar/an external identity-worker UI candidate, and explicit Firefox/Oakland promotion ineligibility. The actual merged production page was checked in light/dark themes, reverse/end seeking, alternative selection, zoom/fit and reduced motion. Actual DPR 1.25 and 2 canvases rendered with no diagnostic measures or page errors; the native browser bridge's ignored DPR override was not counted as DPR-2 coverage—the separate owned Chromium context proved it. Built production assets contain no meeting diagnostic marker strings or routing WASM asset. No fresh public-provider availability, Safari, mobile or weak-GPU pass is claimed.

The r4 compute thresholds and single JS baseline are now frozen above. Record remaining browser/device coverage limitations rather than treating unavailable platforms as passing. No paid provider, API key, native port, shared-memory headers or public-service traffic is required for the local experiments.

Before any GPU production cutover, resolve overlap-history parity and the tested unsupported-GPU behavior. A desire to replace legacy history-dependent colors with a canonical stateless flood is a product/visual decision, not a free optimization.

The experiment is closed as a compute no-go; the traversal/renderer conditional prototypes were not justified by the measured controls and stated visual/lifetime risks. Available-browser checks do not establish Safari, mobile or weak-GPU performance, and source review is not a fatal-trap execution test. Every permanent change follows verify → commit/push → PR → commit-matched Cloudflare preview; no localhost-only handoff.

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

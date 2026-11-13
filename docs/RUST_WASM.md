# Rust + WebAssembly in the Astro build

The original exploration shipped in pull request #59. Its crate
(`crates/energy-ring`) and page (`/lab/energy-ring`) prove the pipeline
end to end: Rust source → wasm-pack → Vite → Cloudflare static assets →
browser.

A second crate, `crates/deep-brush` (`/lab/deep-brush`), uses the same
pipeline with wgpu on WebGPU instead of WebGL2; see
[DEEP_BRUSH.md](DEEP_BRUSH.md).

The page is unlisted. Nothing on the site links to it, and it sets
`noindex` through `BaseLayout`, so the only way in is its URL.

The energy-ring measurements below were taken on November 9, 2026 with
rustc 1.96.0, wasm-bindgen 0.2.130, wasm-pack 0.12.1 and 0.15.1, Astro 7.4.7,
Vite 8.3.6. They are not meeting-point measurements.

Meeting-point routing retains JavaScript. Its Rust/WASM prototype passed
correctness checks but failed the end-to-end performance gate and was removed
from the active build. No meeting-point GPU implementation was promoted.
See [MEETING_POINT_WASM.md](MEETING_POINT_WASM.md) for the measured decision and
archived prototype; the audio-lab findings below are separate and unchanged.

## Layout

| Path                              | Role                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------ |
| `Cargo.toml`, `Cargo.lock`        | Workspace over `crates/*`. Release profile tuned for size.                     |
| `rust-toolchain.toml`             | Stable channel plus the `wasm32-unknown-unknown` target.                       |
| `crates/energy-ring/`             | The renderer crate. GLSL in `src/shaders/` is compiled in with `include_str!`. |
| `crates/energy-ring/pkg/`         | wasm-pack output: ES module glue, typings, `.wasm`. Generated; gitignored.     |
| `src/scripts/energy-ring.ts`      | Client entry. Imports the glue, owns the frame loop and canvas sizing.         |
| `src/lib/audio-bus.ts`            | Page audio tap shared by any future consumer.                                  |
| `src/lib/demo-loop.ts`            | Synthesizes the demo loop so the page ships no audio asset.                    |
| `src/pages/lab/energy-ring.astro` | The test page.                                                                 |
| `crates/deep-brush/`              | Depth-aware WebGPU lab; see `DEEP_BRUSH.md`.                                   |
| `crates/deep-brush/pkg/`          | Generated Deep Brush glue, typings and WASM; gitignored.                       |

## Build pipeline

`bun run build:wasm` builds the two active lab crates in order:

1. `wasm-pack build crates/energy-ring --release --target web --no-pack`
2. `wasm-pack build crates/deep-brush --release --target web --no-pack`

Cargo builds for `wasm32-unknown-unknown`; wasm-bindgen at the version pinned
in `Cargo.lock` emits each crate's glue, typings and binary under its `pkg/`.
For energy-ring these are `energy_ring.js` and `energy_ring_bg.wasm`.

`bun run build` runs this between `sync:projects` and `astro build`. The
energy-ring build flags, release settings and disabled `wasm-opt` are unchanged.

For energy-ring, Vite needs no plugin. The `--target web` glue locates its binary with
`new URL('energy_ring_bg.wasm', import.meta.url)`, which Vite rewrites to a
content-hashed asset. In the production build that is
`dist/client/_astro/energy_ring_bg.<hash>.wasm`, served by Workers Static
Assets as `application/wasm` with the existing immutable `/_astro/*` cache
header, so the browser compiles it while streaming. The crate is client-only:
nothing from it enters the Worker bundle.

Local prerequisites are Node/Bun as listed in [README.md](../README.md#local-development),
Rust stable via rustup, and wasm-pack 0.12 or newer on `PATH`.
`rust-toolchain.toml` adds the `wasm32-unknown-unknown` target; CI uses
wasm-pack 0.15.1. Install JavaScript dependencies with `bun install`.

Local loop:

- Run `bun run build:wasm` before `bun run dev` or `bun run astro check`.
  Both lab pages import generated glue and typings.
- Rebuild after Rust or shader changes. The energy-ring dev page reloads when
  its `pkg/` changes. There is no Rust file watcher.

Keep generated `crates/*/pkg/` outside `src/` and untracked; `.gitignore`
already excludes generated packages.

## Findings

**Generated output must stay outside `src/`.** The first attempt wrote the
package to `src/wasm/`. The dev server's dependency scan treats every file
under `src/` as an entry and parses wasm-bindgen's `.d.ts` files as modules,
which fails (`Missing initializer in const declaration`). Vite then logs
`Failed to run dependency scan. Skipping dependency pre-bundling`, which
defeats the SSR pre-bundling this repo relies on for
[withastro/astro#16248](https://github.com/withastro/astro/issues/16248).
wasm-pack's default `crates/<name>/pkg` avoids it.

**`wasm-opt` is off.** wasm-pack 0.12.1 downloads a Binaryen that cannot
parse the bulk-memory opcodes current rustc emits
(`invalid code after misc prefix: 17`), so the build failed on a machine
with that version. `wasm-opt = false` in the crate manifest makes 0.12.1 and
0.15.1 produce the same 71.7 KB binary. The cost, measured with Binaryen 132
(`wasm-opt -Os --all-features`) on an earlier build of the crate:

| Build            | Raw     | gzip -9 |
| ---------------- | ------- | ------- |
| Shipped (no opt) | 71.7 KB | 25.6 KB |
| With `wasm-opt`  | 39.7 KB | 18.8 KB |

Recovering those 7 KB means either requiring a recent wasm-pack everywhere
or adding the `binaryen` npm package as a pinned build step. Not done here.

**Shipped size.** A local production build (rustc 1.96.0) emits a 72.2 KB
`.wasm` (25.8 KB gzip) and an 11.6 KB script chunk (4.7 KB gzip) holding
the glue, page script, audio bus, and demo synthesizer. Both load only on
the lab page.

**The compiler version changes the binary.** `rust-toolchain.toml` follows
the `stable` channel. For the first version of the crate, CI resolved that
to rustc 1.99.1 and built a 79.5 KB `.wasm` (25.4 KB gzip) where the local
build, from the same source and lockfile, was 72.6 KB (25.9 KB gzip).
Pinning `channel` to an exact version would make local and CI output
match, at the cost of a toolchain download on each machine and manual
bumps.

**Build time** on the development machine: about 40 s cold (wasm-bindgen
and web-sys compile once), 5–13 s after a Rust or GLSL change, under 5 s
when nothing changed.

**Type checking.** `bun run astro check` passes with the generated typings;
`EnergyRing` is fully typed in the page script. `crates/*/pkg` and `target`
are excluded from `tsconfig.json` so generated files are checked only
through imports.

**Dev server watcher.** `astro.config.ts` ignores `**/target/**`. Cargo
rewrites thousands of files there on each build.

**CI.** All three jobs in `.github/workflows/cloudflare-deploy.yml`—`Build`
(`build`), `Preview Deploy` (`preview`), and `Deploy` (`deploy`)—install the
toolchain (`rustup toolchain install`, read from `rust-toolchain.toml`),
restore a Cargo cache (`Swatinem/rust-cache`), and install wasm-pack 0.15.1
(`taiki-e/install-action`). Each runs `build:wasm` for energy-ring and Deep
Brush before building the site; generated bindings exist before type checking.
`bun run build` repeats the WASM build using the warm Cargo cache.

Timing from the first run on PR #59, with cold caches: in the build job the
toolchain step took 4 s (it downloaded the wasm32 standard library), the
cache restore 5 s, wasm-pack under 1 s, and the WebAssembly build 32 s,
about 45 s in total. The preview job compiles the crate again inside
`bun run build` (40 s, against 11 s on an earlier pull request) because the
Cargo cache is keyed per job.

## Who does what

JavaScript keeps what the browser already schedules: the
`requestAnimationFrame` loop, canvas sizing through a `ResizeObserver`
(device pixel ratio capped at 2), and the audio graph.

Rust owns everything between the `AnalyserNode` and the pixels:

- `analysis.rs` folds the byte spectrum into 64 log-spaced bands with
  attack/release smoothing, derives bass, mid, and treble levels, and
  detects bass onsets.
- `camera.rs` is a fixed perspective camera that looks down at the ring's
  plane with a slight roll, so the ring reads as a sloped ellipse.
- `ring.rs` builds the ring every frame. The spectrum lifts the rim along
  the ring's normal, out of its plane, never radially. The module projects
  the 3D points itself and emits screen-space triangle strips: a
  translucent curtain from the rest circle up to the lifted crest, and
  glowing ribbons along both.
- `sparks.rs` simulates up to 1,024 sparks in 3D that leave the crest along
  the normal.
- `lib.rs` holds the WebGL2 context and issues every draw call: seven
  additive draws from one vertex buffer (the curtain, five ribbons, and
  the sparks).

The GPU does no 3D math. The three fragment shaders only shade glow
profiles, so the per-pixel cost is small and limited to what the ring
covers.

Per frame, JavaScript makes one `frame` call into WebAssembly, plus four
reads for the page's level meters. Neither bulk buffer is copied across the
boundary: the analyser writes its spectrum straight into WebAssembly
memory, and the frame's vertices upload from a view of that memory.

`prefers-reduced-motion` turns on calm mode, which removes beat flashes,
sparks, and the ring's spin.

## Would wgpu help?

Not for this page. A throwaway crate on wgpu 30.0.1 with a comparable load
(one uniform, one texture, a dynamic vertex buffer, two additive pipelines)
and the same release profile gave these numbers. It was compiled and
linked only, never run in a browser.

| Renderer                        | `.wasm` raw | gzip -9 | Cold build |
| ------------------------------- | ----------- | ------- | ---------- |
| This crate (`web-sys`, WebGL2)  | 72.2 KB     | 25.8 KB | about 40 s |
| wgpu, WebGPU backend only       | 206 KB      | 63.9 KB | 71 s       |
| wgpu, WebGPU and WebGL2 backend | 2.69 MB     | 924 KB  | 139 s      |

The WebGPU-only build draws nothing where WebGPU is missing. According to
the [WebGPU implementation status](https://github.com/gpuweb/gpuweb/wiki/Implementation-Status)
page (October 2026) that still covers Firefox on Linux and Android, Chrome
on most Linux GPUs and on Windows ARM64, and Safari before version 26.
Reaching those through wgpu means shipping the 924 KB build.

The ring needs seven additive draws from one small vertex buffer, which
WebGL2 handles without strain. wgpu starts to pay for itself when the work
needs compute shaders, for example simulating hundreds of thousands of
particles on the GPU, or when the same renderer must also run natively.

## "Any audio the page plays"

Browsers expose no stream of everything a page plays. `audio-bus.ts` gets
close by listening for `play` on the document (capture phase) and routing
each `<audio>` or `<video>` element through one shared `AudioContext`:

    element → input gain → analyser → speakers

The lab page's own player is picked up the same way; it is not special-cased.

Limits:

- Cross-origin iframes (YouTube, Spotify, SoundCloud embeds) cannot be
  tapped.
- Cross-origin media without CORS approval is skipped. Routing it would
  replace its output with silence.
- Elements that never join the document, and Web Audio graphs on their own
  `AudioContext`, are not seen. Code that owns such a graph can connect it
  to the bus's `input` node.
- Routing is permanent for an element, and the analyser sees the signal
  after the element's own volume. Muting the player silences the ring.
- Capturing the whole tab (`getDisplayMedia`) would cover every source but
  needs a permission prompt on each visit and works only in some browsers.
  Not implemented.

## Verification

- Dev server and the production Workers preview (`bun run build`, then
  `bun run preview`): the page loads the module, plays the demo loop, and
  the bass, mid, treble, and beat readouts follow the audio.
- Chrome (headless, NVIDIA RTX 5090 through ANGLE/D3D11) and Firefox 159 on
  Windows. Between 157 and 165 frames per second while playing.
- Pull request #59: CI passed on the first, flat version of the ring. Its
  Cloudflare preview deployment, loaded in Chrome, served the module as
  `application/wasm`, played the demo loop, and the readouts followed the
  audio.
- Not tested: Safari, mobile browsers, low-end GPUs.

## Open items

- WebGL context loss is not handled; the ring stays blank until reload.
- Without WebGL2 the page reports the error in its status line and shows
  no fallback visual.
- The beat detector and band shaping were tuned against the synthesized
  loop only.

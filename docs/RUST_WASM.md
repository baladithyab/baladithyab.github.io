# Rust + WebAssembly in the Astro build

Exploration on the `t3/rust-wasm-audio-energy-ring` branch. One crate
(`crates/energy-ring`) and one page (`/lab/energy-ring`, not in the
navigation) prove the pipeline end to end: Rust source → wasm-pack → Vite →
Cloudflare static assets → browser.

Measurements below were taken on November 9, 2026 with rustc 1.96.0,
wasm-bindgen 0.2.130, wasm-pack 0.12.1 and 0.15.1, Astro 7.4.7, Vite 8.3.6.

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

## Build pipeline

`bun run build:wasm` runs
`wasm-pack build crates/energy-ring --release --target web --no-pack`:

1. `cargo build --release --target wasm32-unknown-unknown`.
2. wasm-bindgen, at the version pinned in `Cargo.lock`, emits
   `energy_ring.js`, `energy_ring.d.ts`, and `energy_ring_bg.wasm`.

`bun run build` runs it between `sync:projects` and `astro build`.

Vite needs no plugin. The `--target web` glue locates its binary with
`new URL('energy_ring_bg.wasm', import.meta.url)`, which Vite rewrites to a
content-hashed asset. In the production build that is
`dist/client/_astro/energy_ring_bg.<hash>.wasm`, served by Workers Static
Assets as `application/wasm` with the existing immutable `/_astro/*` cache
header, so the browser compiles it while streaming. The crate is client-only:
nothing from it enters the Worker bundle.

Local loop:

- Run `bun run build:wasm` once before `bun run dev` or `bun run astro check`.
  The page's script imports generated files, and the type check reads the
  generated typings.
- After a Rust or GLSL change, run `bun run build:wasm` again. The running
  dev server reloads the page when `pkg/` changes. There is no Rust file
  watcher.

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

**Shipped size.** The production build emits a 72.6 KB `.wasm` (25.9 KB
gzip) and a 12.1 KB script chunk (4.9 KB gzip) holding the glue, page
script, audio bus, and demo synthesizer. Both load only on the lab page.

**Build time** on the development machine: about 40 s cold (wasm-bindgen
and web-sys compile once), 5–13 s after a Rust or GLSL change, under 5 s
when nothing changed.

**Type checking.** `bun run astro check` passes with the generated typings;
`EnergyRing` is fully typed in the page script. `crates/*/pkg` and `target`
are excluded from `tsconfig.json` so generated files are checked only
through imports.

**Dev server watcher.** `astro.config.ts` ignores `**/target/**`. Cargo
rewrites thousands of files there on each build.

**CI.** Each job in `.github/workflows/cloudflare-deploy.yml` builds the
site, so each now installs the toolchain (`rustup toolchain install`, read
from `rust-toolchain.toml`), restores a Cargo cache
(`Swatinem/rust-cache`), and installs wasm-pack 0.15.1
(`taiki-e/install-action`). The build job also runs `build:wasm` before the
type check. These workflow changes have not run yet; the added CI time is
unmeasured.

## Who does what

JavaScript keeps what the browser already schedules: the
`requestAnimationFrame` loop, canvas sizing through a `ResizeObserver`
(device pixel ratio capped at 2), and the audio graph.

Rust owns everything between the `AnalyserNode` and the pixels:

- `analysis.rs` folds the byte spectrum into 64 log-spaced bands with
  attack/release smoothing, derives bass, mid, and treble levels, and
  detects bass onsets.
- `sparks.rs` simulates up to 1,024 additive point sprites.
- `lib.rs` holds the WebGL2 context and issues every draw call: one
  full-screen fragment shader for the ring and one point-sprite pass.

Per frame, JavaScript makes one `frame` call into WebAssembly, plus four
reads for the page's level meters. Neither bulk buffer is copied across the
boundary: the analyser writes its spectrum straight into WebAssembly
memory, and spark vertices upload from a view of that memory.

`prefers-reduced-motion` turns on calm mode, which removes beat flashes and
sparks.

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
  Windows. About 165 frames per second while playing in both.
- Not tested: Safari, mobile browsers, low-end GPUs.

## Open items

- WebGL context loss is not handled; the ring stays blank until reload.
- Without WebGL2 the page reports the error in its status line and shows
  no fallback visual.
- The beat detector and band shaping were tuned against the synthesized
  loop only.

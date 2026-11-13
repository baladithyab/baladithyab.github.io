# Deep Brush: depth-aware painting in Rust, WebAssembly and WebGPU

`/lab/deep-brush` recreates the core ideas of Adobe's
[Project Deep Brush](https://labs.adobe.com/sneaks/deep-brush), shown at the
MAX 2026 Sneaks on November 11, 2026. The page is unlisted and `noindex`,
like `/lab/energy-ring`.

## What Adobe showed

From the Sneak transcript, the Adobe Labs page, and
[CNET's preview](https://www.cnet.com/tech/services-and-software/adobe-max-2026-sneaks-ai-photo-video-editing-exclusive/)
(presenter: Iliyan Georgiev):

- The brush infers "the geometry in the scene, the intrinsic color, the
  lighting": the photo is split into "physically decomposed layers".
- Paint lands on surfaces, not the image plane. A stroke on a wall goes
  behind a person standing in front of it.
- Painting surface colour keeps the photo's lighting.
- Modes: flat, tilt, and warp. Warp wraps paint, textures and text around
  curved surfaces (fabric, skin).
- Smart masks, including a colour mask ("avoid the eye").
- Painting light into the scene, restricted to brushed regions, with
  adjustable light.

Adobe has published no paper for it.

## How the Labs preview works

The [Labs Playground preview](https://projectdeepbrush.adobelabs.com/) runs
its editor in the browser on WebGPU; its client code (JavaScript and WGSL
shaders served to every visitor, read on November 12, 2026) shows the
mechanism:

- **Layers come from a server.** "Load layers" fetches an intrinsic
  decomposition from Adobe Firefly (feature `filix3_rgbx_v1`, an
  [RGB↔X](https://iliyan.com/publications/RGBX) diffusion model by
  Georgiev and colleagues): albedo, RGB shading, normals, depth, glossiness,
  and a specular residual (original − gScale · albedo · shading). The
  composite is `gScale · albedo · shading + residual`.
- **Paint edits the albedo layer**, with a per-stroke peak-coverage envelope
  so overlapping dabs do not darken.
- **Tips.** Flat is an image-plane ellipse. Tilt is the exact perspective
  image of a disk lying in the tangent plane at each dab, oriented by the
  normal under the dab. Warp bakes the brush or decal through a UV chart
  from an ARAP-style surface parametrization (a WebAssembly module,
  `meshless-decal`). Consecutive dabs are joined by swept segments. None of
  the tips test depth.
- **Occlusion is a smart mask.** At pointer-down it samples a 7 × 7 patch
  (log-depth, normal, CIELAB colour): the value under the pointer (the
  seed) and, per cue, the patch's robust centre, spread and per-ring
  similarity. Each cue accepts a capsule in feature space from the seed
  towards the centre; its radius is the cue's tolerance, widened by
  1.5 × the patch spread. A pixel's distance to each capsule is measured in
  units of that tolerance, the cues are combined with a 4-norm, and
  coverage ramps across 1 ± 0.15. Strengths run 0 (off) to 100; 50 is the
  base tolerance, and other values follow an exponential easing (25 is
  about 2.7× looser in depth, 75 about 3× stricter). The smart-mask toggle
  sets all three cues to 50. The reference stays fixed for the stroke;
  per-cue "dynamic" switches, all off by default, re-sample it as the
  stroke moves, easing towards similar samples and jumping to different
  ones. Connectivity is optional, so the wall between someone's legs is
  painted like the rest of the wall.
- **Light** is painted as masks for directional lights, shaded with the
  normals and glossiness and soft-light blended onto the composite.

## What this lab does

Everything runs in the visitor's browser; nothing is sent to a server.

| Deep Brush                    | Here                                                                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Depth from one photo          | Depth Anything V2 Small, ported to WGSL compute shaders, run through wgpu. Edges are sharpened against the photo during upsampling (see Geometry).                             |
| Normals                       | Derived from depth with one-sided differences. Adobe's come from RGB↔X.                                                                                                        |
| Intrinsic colour and lighting | Retinex-style split: shading = (L / blurred L) · (blurred L / white)^0.6. Heuristic and grey; Adobe's is RGB↔X with RGB shading and a specular residual.                       |
| Flat / Tilt / Warp tips       | Flat and Tilt as in the preview (Tilt: disk on the tangent plane at each dab, no depth test). Warp measures distance walked over the depth surface, not an ARAP chart.         |
| Occlusion ("under the arm")   | The preview's smart mask, ported: seed and patch statistics, capsule ranges, strength easing, 4-norm, soft band, fixed reference (optional re-sampling). Per pixel on the GPU. |
| Paint keeps the lighting      | The paint layer stores albedo; the composite multiplies it by the shading.                                                                                                     |
| Paint light                   | A light layer adds `albedo · light colour · max(n·l, 0)`; the photo's own light can be dimmed.                                                                                 |
| Text, logos, tattoos          | Decals (text rendered by the page, or any image) placed with the same tips and the same mask.                                                                                  |

The page also shows the depth, normal, shading and albedo maps, undoes up to
eight strokes, and saves the result as a full-resolution PNG. Any image the
browser can decode works: file picker, drag and drop, or paste. Images are
scaled to at most 2048 px on the longer side.

## Layout

| Path                                   | Role                                                                             |
| -------------------------------------- | -------------------------------------------------------------------------------- |
| `crates/deep-brush/src/depth.rs`       | Depth Anything V2 Small: weight upload, one dispatch plan per input size.        |
| `crates/deep-brush/src/shaders/model/` | WGSL kernels: tiled matmul, LayerNorm, attention, conv, transposed conv, resize. |
| `crates/deep-brush/src/preprocess.rs`  | `DPTImageProcessor` sizing, PIL-style bicubic resize, position-embedding resize. |
| `crates/deep-brush/src/safetensors.rs` | Reads the weights header; tensors are copied one at a time.                      |
| `crates/deep-brush/src/geometry.rs`    | CPU depth, positions, normals and tangent frames for anchoring dabs.             |
| `crates/deep-brush/src/mask.rs`        | Smart mask: reference sampling, following, tolerances.                           |
| `crates/deep-brush/src/editor.rs`      | Layers, stroke buffer, undo, composite, export.                                  |
| `crates/deep-brush/src/shaders/edit/`  | Normals and shading passes, dab and decal footprints, compositing.               |
| `crates/deep-brush/src/web.rs`         | wasm-bindgen API (`DeepBrush`). Compiled only for `wasm32`.                      |
| `crates/deep-brush/examples/`          | Native harnesses: `depth` (model only) and `paint` (scripted edits).             |
| `src/pages/lab/deep-brush.astro`       | The page.                                                                        |
| `src/scripts/deep-brush.ts`            | Input, decoding, model download and caching, frame scheduling.                   |
| `public/lab/deep-brush/sample.jpg`     | AI-generated sample photo (no real person), 1536×1024.                           |

`bun run build:wasm` builds this crate after `energy-ring`, with the same
`wasm-pack --target web` setup described in [RUST_WASM.md](RUST_WASM.md).

## The depth model

Weights: [`depth-anything/Depth-Anything-V2-Small-hf`](https://huggingface.co/depth-anything/Depth-Anything-V2-Small-hf)
(Apache-2.0; the Base and Large checkpoints are non-commercial and are not
used), revision `5426e4f0f36572d16453bbda7a8389317b1bef99`, 24.8 M
parameters, 99 MB as float32 safetensors.

The page downloads the file from Hugging Face only when "Load depth model" is
pressed and keeps it in Cache Storage (`deep-brush-model-v1`). The Worker
serves none of it, which also keeps it clear of the 25 MiB static-asset limit.

Hugging Face answers with CORS headers for any `Origin`, but its CDN returns
404 without them when the `Referer` is a `*.workers.dev` page, which is every
pull-request preview (checked with curl on November 12, 2026; `codeseys.io`
and `localhost` are accepted). The download therefore uses
`referrerPolicy: 'no-referrer'`. The first preview deployment of this lab
failed with "Failed to fetch" before that change.

The port follows `transformers` 5.22.2 operation by operation: 14×14 patch
embedding, bicubic position-embedding resize, 12 pre-norm ViT blocks with
layer scale, LayerNorm on the outputs of blocks 3, 6, 9 and 12, the DPT
reassemble stage (1×1 projection, transposed conv ×4 and ×2, identity,
strided conv), the four fusion blocks with pre-activation residual units and
`align_corners=True` upsampling, and the three-conv head. Query, key and
value weights are concatenated at load, so one matmul produces all three.
Attention streams keys and values through workgroup memory with an online
softmax; the score matrix is never stored.

### Parity with PyTorch

`examples/depth.rs` writes its normalized input tensor; a throwaway script
fed the same tensor to `DepthAnythingForDepthEstimation` (PyTorch 2.15.0 CPU,
float32). On the sample at 784×518:

| Measure                     | Value             |
| --------------------------- | ----------------- |
| Output range (both)         | 0.5871 to 11.2798 |
| Largest absolute difference | 0.00017           |
| Mean absolute difference    | 0.000001          |
| Largest difference / range  | 1.5 × 10⁻⁵        |
| Pearson correlation         | 1.0000000         |

### Speed

| Where                                                | 784×518 input |
| ---------------------------------------------------- | ------------- |
| Native, Vulkan, RTX 5090 (`examples/depth`, warm)    | 74 ms         |
| Chrome headless, WebGPU, same machine, first image   | 1051 ms       |
| Same page after a reload, weights from Cache Storage | 543 ms        |

The release `.wasm` (wgpu 30, WebGPU backend only, `wasm-opt` off as for
`energy-ring`) is 573,064 bytes, 191,702 with `gzip -9`. It loads only on
this page.

Browser times include planning (≈ 170 bind groups and about 300 MB of
activation buffers), the CPU resize, and readback. The first version of the
attention kernel indexed per-thread arrays dynamically and took 374 of 430 ms
natively; constant trip counts and `vec4` arithmetic brought attention down
by a factor of ten.

## Geometry

- Disparity is normalized between its 1st and 99th percentiles and mapped
  to depth 1…4. The model's output has an unknown scale and shift, so the
  range is a choice. A 1…10 range was tried first: depth is 1 / disparity,
  so it magnified the model's error on the far wall by up to 100× and
  tilted its normals by tens of degrees.
- At the model resolution, a 5 × 5 bilateral filter removes texel ripple
  without moving object boundaries (a Gaussian, used before, blurred
  silhouettes into a band several pixels wide).
- Upsampling to the edit resolution is bilinear where depth is flat. Near
  depth edges it is a joint bilateral upsample guided by the photo, which
  also down-weights texels inside the model's own blurred edge band. A
  pixel beside a silhouette therefore takes the depth of clean texels of
  its own colour, and the occlusion edge lands on the image edge.
- The camera is assumed to have a 60° field of view across the longer side.
- Normals use one-sided differences about one upsampled model texel long,
  taken from the side whose depth changes least, so they do not average
  across silhouettes.

## Strokes

- Dabs are spaced at 15% of the radius, independent of pointer-event
  density. Coalesced samples and the pointer-up endpoint are processed too.
  Long segments flush through a reusable instance batch.
- Tips do not test depth (as in the preview). Each dab is placed at the
  surface point under it; Tilt and Warp orient it by the normal there.
- The smart mask (`mask.rs`, `smart_mask` in `stamp.wgsl`) follows the
  preview's code: the same patch statistics, capsule ranges, strength
  easing, tolerances (0.1487 in log-depth, about 16 %; 45°; ΔE 7.6 on
  CIELAB / 100), texture adaptivity and soft band. The reference is fixed
  at pointer-down; "Re-sample along the stroke" turns on the preview's
  dynamic mode for all three cues at once. Not ported: the preview limits
  the patch to pixels connected to the seed across its geometry edges
  (here, the similarity weights already discount pixels across an edge),
  and it anti-aliases the mask boundary.
- Defaults: Depth 50, Surface direction 40, Colour off. The preview's
  toggle sets all three to 50. Its normals come from RGB↔X; normals
  derived from monocular depth bend by 45–60° in the patch of wall between
  the sample's legs, which left holes at 50 (81–91 % painted) and fills at
  40 (95–97 %) while a stroke still stops at the wall–floor corner. At 30
  it slid onto the floor (13 %). Colour is off because it compares the
  original photo, so dappled light on a wall cuts strokes at its shadows.
- Dabs accumulate with `max` blending in a stroke buffer, so overlapping
  dabs do not darken. Pointer-up merges the stroke into its layer with
  "over"; erasing uses `dst · (1 − a)`.
- Two earlier designs were replaced. A connected-surface lock (flood fill
  over depth and normal discontinuities) left a halo around people and
  could not reach wall enclosed by an occluder. A reference that always
  followed the stroke and rejected jumps crept from a wall onto the floor
  through the corner's gradually turning normals; the preview keeps the
  reference fixed by default.

## Workspace

The canvas stays visible beside the tool inspector on desktop. Image input,
depth analysis, undo and PNG export live in the document bar; Surface and
Wrap cannot silently paint flat before depth is ready. Radius, hardness and
opacity have live values, a brush cursor shows the image-space radius, and
only settings relevant to the selected tool are shown. The smart mask has
its own group: an on/off switch, the three cue strengths (0 shows "Off")
and the re-sampling option. Layer views are keyboard-operable radio
controls. Shortcuts: B/L/E/D for tools, brackets for radius, Ctrl/Cmd+Z to
undo, Enter/Escape to apply/cancel a decal.

## Verification

- `examples/paint` on the sample: a tilt stroke across the wall passes
  behind the crouching figure and meets his silhouette without a gap; a
  test card decal stays rigid in tilt and compresses towards the pillar's
  silhouette in warp; a colour-masked stroke started on the t-shirt stays
  off the wall; painted light dims and relights the figure; undo restores
  the light layer.
- Headless Chrome (WebGPU, Windows, RTX 5090) through Playwright against
  `bun run dev`: the sample loads, the model downloads and runs, a dragged
  tilt stroke goes behind the figure, a warp text decal wraps the pillar,
  the normal view renders, Ctrl+Z removes the decal, and a reload loads the
  weights from Cache Storage. No console errors.
- `bun run build`, then `bun run preview` (workerd): the page carries
  `noindex`, the `.wasm` is served as `application/wasm` with the immutable
  `/_astro/*` cache header, and headless Chrome estimated depth on the
  sample in 591 ms with no console errors. `bun run test:worker` passes.
- `bun run astro check`: no errors or warnings.
- GPU regressions, `cargo test -p deep-brush --test smart_mask -- --ignored`
  (requires a GPU), through the real render path in Flat, Tilt and Warp:
  a figure on two legs in front of a wall, its depth given at half
  resolution with soft edges. The legs stay clean; the wall between them is
  painted; wall pixels 3 px from each silhouette are painted (no halo); the
  stroke resumes past the figure, for one pointer event or one per pixel.
  Without the mask the brush paints over the figure. A stroke started on a
  wall stays off a floor joined to it by a softened corner, straight down
  or sliding towards the corner. Unit tests cover the strength easing, a
  patch partly covered by an occluder, and re-sampling.
- In Chrome on the dev server, seven strokes on the sample (behind the
  head, across the shirt and arm, two through the wall between the legs,
  two from the wall down towards the floor, one into the pillar): no halo
  at the silhouettes, the gap between the legs filled, no paint on the
  floor, the pillar or the figure.
- `set_depth` (bilateral filter, guided upsampling, geometry) takes 167 ms
  at 1536 × 1024 and 238 ms at 2048 × 1365 in a native release build on the
  development workstation; a 400-event stroke takes 28–35 ms including GPU
  work.
- Earlier rounds checked export, layer inspection, contextual tool
  settings and live values, and the phone and desktop layouts in light and
  dark themes.
- Not tested on physical phones or tablets, Firefox, Safari, integrated GPUs,
  or very large images. Narrow viewport checks are desktop Chromium emulation.

## Limits

- WebGPU only. There is no WebGL fallback; the page says so and disables its
  controls. See the support notes in [RUST_WASM.md](RUST_WASM.md).
- The shading split is a heuristic. By construction, a dark material
  surrounded by brighter ones reads partly as shadow, so paint on it comes
  out darker than it should. Adobe uses learned intrinsic decomposition.
- Monocular depth has systematic bias. On the sample, the cylindrical
  pillar's normals lean upwards (green in the normal view) instead of
  facing sideways; warp still wraps decals around it horizontally. The
  model also bends the wall towards people standing in front of it, which
  is why the default normal strength is 40 rather than the preview's 50.
- Depth quality bounds everything: hair and reflective surfaces get
  uncertain depth, and structures thinner than about four model texels
  (8 px on the sample) take their depth from colour alone.
- The mask matches surfaces by depth, direction and colour, not by
  object. A different object at the same depth and orientation as the
  starting surface (a poster flat on the wall) is painted too; raise
  Colour to separate it.
- Not matched, because they need models or code this lab does not have:
  RGB↔X layers (albedo, RGB shading, specular, glossiness) and learned
  normals, the ARAP texture chart behind Warp, swept dabs and the
  lazy-string stroke stabilizer, and light masks blended as soft light.
- Light is a single directional light shading painted regions; it casts no
  shadows.
- Peak GPU memory while estimating depth is about 300 MB for wide images;
  undo keeps up to eight layer snapshots (8 bytes per pixel each).
- Depth post-processing (bilateral filter and guided upsampling) runs
  synchronously on the main thread when depth is installed: about 0.2 s
  natively at 2048 px, more in WebAssembly.

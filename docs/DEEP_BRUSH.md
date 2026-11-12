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

Adobe has published no paper or code for it. Everything below is an
independent reconstruction from those descriptions.

## What this lab does

| Adobe feature                       | Here                                                                                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Scene geometry from one photo       | Depth Anything V2 Small, ported to WGSL compute shaders, run through wgpu. Normals from the depth by central differences.            |
| Intrinsic colour and lighting       | Retinex-style split: shading = (L / blurred L) · (blurred L / white)^0.6. Heuristic, not learned.                                    |
| Paint on surfaces, behind occluders | Every dab is anchored to a 3D point and tangent plane. Pixels off that surface are skipped; the stroke reacquires the surface later. |
| Flat / tilt / warp                  | Flat: image-plane disc. Tilt: disc on the tangent plane (perspective foreshortening). Warp: distance walked over the depth surface.  |
| Paint keeps the lighting            | The paint layer stores albedo; the composite multiplies it by the photo's shading.                                                   |
| Colour mask                         | Optional: dabs only cover colours near the one under the first dab.                                                                  |
| Paint light                         | A light layer adds `albedo · light colour · max(n·l, 0)`; the photo's own light can be dimmed.                                       |
| Text, logos, tattoos                | Decals (text rendered by the page, or any image) placed with the same three modes.                                                   |

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
pressed (Hugging Face answers with CORS headers for any origin) and keeps it in
Cache Storage (`deep-brush-model-v1`). The Worker serves none of it, which
also keeps it clear of the 25 MiB static-asset limit.

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
`energy-ring`) is 546.5 KB, 182.3 KB with `gzip -9`. It loads only on this
page.

Browser times include planning (≈ 170 bind groups and about 300 MB of
activation buffers), the CPU resize, and readback. The first version of the
attention kernel indexed per-thread arrays dynamically and took 374 of 430 ms
natively; constant trip counts and `vec4` arithmetic brought attention down
by a factor of ten.

## Geometry

- Disparity is smoothed (σ = 1.2 model pixels), normalized between its 1st
  and 99th percentiles, and mapped to depth 1…4. The model's output has an
  unknown scale and shift, so the range is a choice. A 1…10 range was tried
  first: depth is 1 / disparity, so it magnified the model's error on the
  far wall by up to 100× and tilted its normals by tens of degrees.
- The camera is assumed to have a 60° field of view across the longer side.
- Normals use central differences a little wider than one upsampled model
  texel.

## Strokes

- Dabs are spaced at 15 % of the radius. Each carries its anchor point,
  normal and tangent frame.
- The stroke stays on its surface. While the pixel under the cursor lies on
  the previous dab's tangent plane (within 5 % of depth), the anchor follows
  it. When it jumps off, the anchor stays at the depth where the surface was
  last seen, and the stroke picks the surface up again within 12 % of that
  depth. Extrapolating the tangent plane across the gap was tried first; it
  drifted onto the person in the sample, because monocular normals of the
  wall were off by about 20°.
- In tilt and warp, a fragment is drawn only where the depth agrees with the
  anchored surface. Warp walks 20 steps from the anchor to the pixel over the
  depth surface, continuing on the predicted plane where something occludes
  it, and uses the walked length as the distance. A step count that grew with
  distance produced visible rings; the fixed count does not.
- Dabs accumulate with `max` blending in a stroke buffer, so overlapping dabs
  do not darken; the stroke is merged into its layer with "over" (or erased
  with `dst · (1 − a)`) when the pointer is released.

## Verification

- `examples/paint` on the sample: a tilt stroke across the wall passes
  behind the crouching figure while a flat stroke paints over him; a test
  card decal stays rigid in tilt and compresses towards the pillar's
  silhouette in warp; a colour-masked stroke started on the t-shirt stays off
  the wall; painted light dims and relights the figure; undo restores the
  light layer.
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
- Not tested: Firefox, Safari, mobile, integrated GPUs, very large images.

## Limits

- WebGPU only. There is no WebGL fallback; the page says so and disables its
  controls. See the support notes in [RUST_WASM.md](RUST_WASM.md).
- The shading split is a heuristic. By construction, a dark material
  surrounded by brighter ones reads partly as shadow, so paint on it comes
  out darker than it should. Adobe uses learned intrinsic decomposition.
- Monocular depth has systematic bias. On the sample, the cylindrical
  pillar's normals lean upwards (green in the normal view) instead of
  facing sideways; warp still wraps decals around it horizontally.
- Depth quality bounds everything: thin structures, hair and reflective
  surfaces get blurred depth, and occlusion edges are soft by a few pixels.
- Light is a single directional light shading painted regions; it casts no
  shadows.
- Peak GPU memory while estimating depth is about 300 MB for wide images;
  undo keeps up to eight layer snapshots (8 bytes per pixel each).

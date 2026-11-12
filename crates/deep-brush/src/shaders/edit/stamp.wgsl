// Brush dabs and decals, drawn into the stroke buffer.
//
// Each instance is one dab or one decal. Its footprint is measured in one of
// three ways:
//   flat: image-plane distance from the centre;
//   tilt: position on the tangent plane at the anchor (perspective
//         foreshortening, rigid);
//   warp: distance walked over the depth surface from the anchor, so the
//         footprint wraps around curved surfaces.
// Tilt and warp skip pixels that do not lie on the anchored surface, which is
// how paint passes behind an arm in front of a wall.

struct Scene {
  size: vec2<f32>,
  focal: f32,
  mask_on: f32,
  mask_color: vec3<f32>,
  mask_tolerance: f32,
  surface_tolerance: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
}

@group(0) @binding(0) var<uniform> scene: Scene;
@group(0) @binding(1) var depth: texture_2d<f32>;
@group(0) @binding(2) var normals: texture_2d<f32>;
@group(0) @binding(3) var image: texture_2d<f32>;
@group(0) @binding(4) var decal: texture_2d<f32>;
@group(0) @binding(5) var decal_sampler: sampler;
@group(0) @binding(6) var surfaces: texture_2d<u32>;

struct Instance {
  // centre (px), quad half-extent (px), kind (0 dab, 1 decal)
  @location(0) a: vec4<f32>,
  // anchor (camera space), footprint radius in world units (px for flat)
  @location(1) b: vec4<f32>,
  // anchor normal, mode (0 flat, 1 tilt, 2 warp)
  @location(2) c: vec4<f32>,
  // tangent, decal height / width
  @location(3) d: vec4<f32>,
  // bitangent, hardness
  @location(4) e: vec4<f32>,
  // linear colour, stroke-start surface ID (dabs only)
  @location(5) f: vec4<f32>,
}

struct Varyings {
  @builtin(position) position: vec4<f32>,
  @location(0) @interpolate(flat) a: vec4<f32>,
  @location(1) @interpolate(flat) b: vec4<f32>,
  @location(2) @interpolate(flat) c: vec4<f32>,
  @location(3) @interpolate(flat) d: vec4<f32>,
  @location(4) @interpolate(flat) e: vec4<f32>,
  @location(5) @interpolate(flat) f: vec4<f32>,
}

@vertex
fn vs(@builtin(vertex_index) vi: u32, inst: Instance) -> Varyings {
  let corner = vec2<f32>(f32(vi & 1u), f32(vi >> 1u)) * 2.0 - 1.0;
  let px = inst.a.xy + corner * inst.a.z;
  var out: Varyings;
  out.position = vec4<f32>(px.x / scene.size.x * 2.0 - 1.0, 1.0 - px.y / scene.size.y * 2.0, 0.0, 1.0);
  out.a = inst.a;
  out.b = inst.b;
  out.c = inst.c;
  out.d = inst.d;
  out.e = inst.e;
  out.f = inst.f;
  return out;
}

fn ray(p: vec2<f32>) -> vec3<f32> {
  return vec3<f32>((p - scene.size * 0.5) / scene.focal, 1.0);
}

fn pixel(p: vec2<f32>) -> vec2<i32> {
  return clamp(vec2<i32>(floor(p)), vec2<i32>(0), vec2<i32>(scene.size) - 1);
}

fn position(p: vec2<f32>) -> vec3<f32> {
  return ray(p) * textureLoad(depth, pixel(p), 0).r;
}

fn on_plane(p: vec2<f32>, origin: vec3<f32>, n: vec3<f32>) -> vec3<f32> {
  let r = ray(p);
  let denom = dot(r, n);
  // Grazing planes: fall back to the anchor's depth.
  if (abs(denom) < 1e-4) {
    return r * origin.z;
  }
  return r * (dot(origin, n) / denom);
}

struct Footprint {
  uv: vec2<f32>,
  visible: bool,
}

fn tilt(p: vec2<f32>, v: Varyings) -> Footprint {
  let x = on_plane(p, v.b.xyz, v.c.xyz);
  let actual = position(p);
  var f: Footprint;
  f.visible = x.z > 0.0 && abs(actual.z - x.z) < scene.surface_tolerance * x.z;
  let q = x - v.b.xyz;
  f.uv = vec2<f32>(dot(q, v.d.xyz), dot(q, v.e.xyz)) / v.b.w;
  return f;
}

// Walks from the anchor to `p` in image space, stepping over the depth
// surface. Each step is predicted on the current tangent plane; when the
// actual depth disagrees (an occluder in front, or the surface ends), the
// walk continues on the prediction and the pixel counts as hidden until the
// surface reappears. The walk length becomes the distance from the anchor;
// its direction comes from the anchor's tangent plane, which is smooth,
// rather than from the first (noisy) step. A fixed step count keeps the
// distance continuous across pixels.
const WARP_STEPS: u32 = 20u;

fn warp(p: vec2<f32>, v: Varyings) -> Footprint {
  let start = v.a.xy;
  let span = p - start;
  let pixels = length(span);
  var f: Footprint;
  var prev = v.b.xyz;
  var n = v.c.xyz;
  f.uv = vec2<f32>(0.0);
  if (pixels < 0.5) {
    let actual = position(p);
    f.visible = abs(actual.z - prev.z) < scene.surface_tolerance * prev.z;
    return f;
  }
  f.visible = true;
  var arc = 0.0;
  for (var i = 1u; i <= WARP_STEPS; i++) {
    let q = start + span * (f32(i) / f32(WARP_STEPS));
    let predicted = on_plane(q, prev, n);
    let actual = position(q);
    var next = predicted;
    let attached = predicted.z > 0.0 && abs(actual.z - predicted.z) < scene.surface_tolerance * predicted.z;
    if (attached) {
      next = actual;
      n = normalize(mix(n, textureLoad(normals, pixel(q), 0).xyz, 0.3));
    }
    f.visible = attached;
    arc += length(next - prev);
    prev = next;
  }
  let toward = on_plane(start + span / pixels, v.b.xyz, v.c.xyz) - v.b.xyz;
  let dir = toward / max(length(toward), 1e-8);
  f.uv = arc * vec2<f32>(dot(dir, v.d.xyz), dot(dir, v.e.xyz)) / v.b.w;
  return f;
}

fn footprint(p: vec2<f32>, v: Varyings) -> Footprint {
  let mode = u32(v.c.w);
  if (mode == 1u) {
    return tilt(p, v);
  }
  if (mode == 2u) {
    return warp(p, v);
  }
  var f: Footprint;
  let d = p - v.a.xy;
  f.uv = vec2<f32>(dot(d, v.d.xy), dot(d, v.e.xy)) / v.b.w;
  f.visible = true;
  return f;
}

fn linear(c: vec3<f32>) -> vec3<f32> {
  return select(pow((c + 0.055) / 1.055, vec3<f32>(2.4)), c / 12.92, c <= vec3<f32>(0.04045));
}

fn color_mask(p: vec2<f32>) -> f32 {
  if (scene.mask_on < 0.5) {
    return 1.0;
  }
  let c = textureLoad(image, pixel(p), 0).rgb;
  let d = distance(c, scene.mask_color);
  return 1.0 - smoothstep(scene.mask_tolerance * 0.6, scene.mask_tolerance, d);
}

@fragment
fn dab(v: Varyings) -> @location(0) vec4<f32> {
  let p = v.position.xy;
  if (v.c.w > 0.5 && textureLoad(surfaces, pixel(p), 0).r != u32(v.f.w)) {
    discard;
  }
  let f = footprint(p, v);
  if (!f.visible) {
    discard;
  }
  let r = length(f.uv);
  let hardness = clamp(v.e.w, 0.0, 0.99);
  let coverage = (1.0 - smoothstep(hardness, 1.0, r)) * color_mask(p);
  if (coverage <= 0.0) {
    discard;
  }
  return vec4<f32>(v.f.rgb * coverage, coverage);
}

@fragment
fn sticker(v: Varyings) -> @location(0) vec4<f32> {
  let p = v.position.xy;
  let f = footprint(p, v);
  let aspect = v.d.w;
  let uv = vec2<f32>(f.uv.x, f.uv.y / aspect) * 0.5 + 0.5;
  if (!f.visible || any(uv < vec2<f32>(0.0)) || any(uv > vec2<f32>(1.0))) {
    discard;
  }
  let texel = textureSampleLevel(decal, decal_sampler, uv, 0.0);
  let alpha = texel.a * color_mask(p);
  return vec4<f32>(linear(texel.rgb) * alpha, alpha);
}

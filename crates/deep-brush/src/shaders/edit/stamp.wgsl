// Brush dabs and decals, drawn into the stroke buffer.
//
// Each instance is one dab or one decal. Its footprint is measured in one of
// three ways:
//   flat: image-plane distance from the centre;
//   tilt: where the pixel's ray meets the tangent plane at the dab, so the
//         footprint is the perspective image of a disk lying on the surface;
//   warp: distance walked over the depth surface from the dab, so the
//         footprint wraps around curved surfaces.
// The footprint ignores occlusion. What sits in front of the surface (an arm
// in front of a wall) is removed by the smart mask, which compares every
// pixel with the range of surfaces the stroke accepts (see mask.rs).

struct Scene {
  size: vec2<f32>,
  focal: f32,
  softness: f32,
}

@group(0) @binding(0) var<uniform> scene: Scene;
@group(0) @binding(1) var depth: texture_2d<f32>;
@group(0) @binding(2) var normals: texture_2d<f32>;
@group(0) @binding(3) var image: texture_2d<f32>;
@group(0) @binding(4) var decal: texture_2d<f32>;
@group(0) @binding(5) var decal_sampler: sampler;

struct Instance {
  // centre (px), quad half-extent (px), kind (0 dab, 1 decal)
  @location(0) a: vec4<f32>,
  // dab point (camera space), footprint radius in world units (px for flat)
  @location(1) b: vec4<f32>,
  // dab normal, mode (0 flat, 1 tilt, 2 warp)
  @location(2) c: vec4<f32>,
  // tangent, decal height / width
  @location(3) d: vec4<f32>,
  // bitangent, hardness
  @location(4) e: vec4<f32>,
  // linear colour
  @location(5) f: vec4<f32>,
  // smart-mask range start: log-depth, CIELAB / 100
  @location(6) g: vec4<f32>,
  // smart-mask range start normal
  @location(7) h: vec4<f32>,
  // smart-mask range end: log-depth, CIELAB / 100
  @location(8) i: vec4<f32>,
  // smart-mask range end normal
  @location(9) j: vec4<f32>,
  // smart-mask tolerances: log-depth, normal angle (radians), colour; 0 = off
  @location(10) k: vec4<f32>,
}

struct Varyings {
  @builtin(position) position: vec4<f32>,
  @location(0) @interpolate(flat) a: vec4<f32>,
  @location(1) @interpolate(flat) b: vec4<f32>,
  @location(2) @interpolate(flat) c: vec4<f32>,
  @location(3) @interpolate(flat) d: vec4<f32>,
  @location(4) @interpolate(flat) e: vec4<f32>,
  @location(5) @interpolate(flat) f: vec4<f32>,
  @location(6) @interpolate(flat) g: vec4<f32>,
  @location(7) @interpolate(flat) h: vec4<f32>,
  @location(8) @interpolate(flat) i: vec4<f32>,
  @location(9) @interpolate(flat) j: vec4<f32>,
  @location(10) @interpolate(flat) k: vec4<f32>,
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
  out.g = inst.g;
  out.h = inst.h;
  out.i = inst.i;
  out.j = inst.j;
  out.k = inst.k;
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
  // Grazing planes: fall back to the dab's depth.
  if (abs(denom) < 1e-4) {
    return r * origin.z;
  }
  return r * (dot(origin, n) / denom);
}

// Footprint coordinates in brush radii; |uv| = 1 at the brush edge.
fn tilt(p: vec2<f32>, v: Varyings) -> vec2<f32> {
  let x = on_plane(p, v.b.xyz, v.c.xyz);
  if (x.z <= 0.0) {
    return vec2<f32>(1e6);
  }
  let q = x - v.b.xyz;
  return vec2<f32>(dot(q, v.d.xyz), dot(q, v.e.xyz)) / v.b.w;
}

// Walks from the dab to `p` in image space, stepping over the depth surface.
// Each step is predicted on the current tangent plane; where the actual depth
// disagrees (an occluder, or the surface ends) the walk continues on the
// prediction. The walked length is the distance from the dab; its direction
// comes from the dab's tangent plane, which is smooth, rather than from the
// first (noisy) step. A fixed step count keeps the distance continuous.
const WARP_STEPS: u32 = 20u;
const WARP_ATTACH: f32 = 0.05;

fn warp(p: vec2<f32>, v: Varyings) -> vec2<f32> {
  let start = v.a.xy;
  let span = p - start;
  let pixels = length(span);
  if (pixels < 0.5) {
    return vec2<f32>(0.0);
  }
  var prev = v.b.xyz;
  var n = v.c.xyz;
  var arc = 0.0;
  for (var i = 1u; i <= WARP_STEPS; i++) {
    let q = start + span * (f32(i) / f32(WARP_STEPS));
    let predicted = on_plane(q, prev, n);
    let actual = position(q);
    var next = predicted;
    if (predicted.z > 0.0 && abs(actual.z - predicted.z) < WARP_ATTACH * predicted.z) {
      next = actual;
      n = normalize(mix(n, textureLoad(normals, pixel(q), 0).xyz, 0.3));
    }
    arc += length(next - prev);
    prev = next;
  }
  let toward = on_plane(start + span / pixels, v.b.xyz, v.c.xyz) - v.b.xyz;
  let dir = toward / max(length(toward), 1e-8);
  return arc * vec2<f32>(dot(dir, v.d.xyz), dot(dir, v.e.xyz)) / v.b.w;
}

fn footprint(p: vec2<f32>, v: Varyings) -> vec2<f32> {
  let mode = u32(v.c.w);
  if (mode == 1u) {
    return tilt(p, v);
  }
  if (mode == 2u) {
    return warp(p, v);
  }
  let d = p - v.a.xy;
  return vec2<f32>(dot(d, v.d.xy), dot(d, v.e.xy)) / v.b.w;
}

fn linear(c: vec3<f32>) -> vec3<f32> {
  return select(pow((c + 0.055) / 1.055, vec3<f32>(2.4)), c / 12.92, c <= vec3<f32>(0.04045));
}

// CIELAB (D65) of an sRGB colour, each component divided by 100.
// Mirrors `lab` in mask.rs.
fn lab(srgb: vec3<f32>) -> vec3<f32> {
  let c = linear(srgb);
  let xyz = vec3<f32>(
    dot(c, vec3<f32>(0.4124, 0.3576, 0.1805)) / 0.95047,
    dot(c, vec3<f32>(0.2126, 0.7152, 0.0722)),
    dot(c, vec3<f32>(0.0193, 0.1192, 0.9505)) / 1.08883,
  );
  let f = select(7.787 * xyz + vec3<f32>(16.0 / 116.0), pow(xyz, vec3<f32>(1.0 / 3.0)), xyz > vec3<f32>(0.008856));
  return vec3<f32>((116.0 * f.y - 16.0) / 100.0, 5.0 * (f.x - f.y), 2.0 * (f.y - f.z));
}

// Angle from `n` to the great-circle arc from `a` to `b` (unit vectors).
fn arc_distance(n: vec3<f32>, a: vec3<f32>, b: vec3<f32>) -> f32 {
  let to_a = acos(clamp(dot(n, a), -1.0, 1.0));
  let axis = cross(a, b);
  let s = length(axis);
  if (s < 1e-6) {
    return to_a;
  }
  let k = axis / s;
  let along = cross(k, a);
  let arc = atan2(s, dot(a, b));
  let x = dot(n, a);
  let y = dot(n, along);
  if (y >= 0.0 && cos(arc) * y - sin(arc) * x <= 0.0) {
    return asin(min(abs(dot(n, k)), 1.0));
  }
  return min(to_a, acos(clamp(dot(n, b), -1.0, 1.0)));
}

// Distance from `p` to the segment from `a` to `b`.
fn segment_distance(p: vec3<f32>, a: vec3<f32>, b: vec3<f32>) -> f32 {
  let d = b - a;
  let len2 = dot(d, d);
  let t = select(0.0, clamp(dot(p - a, d) / len2, 0.0, 1.0), len2 > 1e-12);
  return length(p - a - t * d);
}

// Coverage from the smart mask: each cue's distance to the accepted range in
// units of its tolerance, combined with a 4-norm, then a linear ramp across
// 1 ± softness.
fn smart_mask(p: vec2<f32>, v: Varyings) -> f32 {
  let tol = v.k.xyz;
  if (all(tol <= vec3<f32>(0.0))) {
    return 1.0;
  }
  let q = pixel(p);
  var sum = 0.0;
  if (tol.x > 0.0) {
    let z = log(textureLoad(depth, q, 0).r);
    let lo = min(v.g.x, v.i.x);
    let hi = max(v.g.x, v.i.x);
    let d = max(max(lo - z, z - hi), 0.0) / tol.x;
    sum += d * d * d * d;
  }
  if (tol.y > 0.0) {
    let n = textureLoad(normals, q, 0).xyz;
    let d = arc_distance(n, v.h.xyz, v.j.xyz) / tol.y;
    sum += d * d * d * d;
  }
  if (tol.z > 0.0) {
    let w = vec3<f32>(0.5, 1.0, 1.0);
    let c = lab(textureLoad(image, q, 0).rgb) * w;
    let d = segment_distance(c, v.g.yzw * w, v.i.yzw * w) / tol.z;
    sum += d * d * d * d;
  }
  let distance = sqrt(sqrt(sum));
  return clamp((1.0 + scene.softness - distance) / (2.0 * scene.softness), 0.0, 1.0);
}

@fragment
fn dab(v: Varyings) -> @location(0) vec4<f32> {
  let p = v.position.xy;
  let r = length(footprint(p, v));
  let hardness = clamp(v.e.w, 0.0, 0.99);
  let tip = 1.0 - smoothstep(hardness, 1.0, r);
  if (tip <= 0.0) {
    discard;
  }
  let coverage = tip * smart_mask(p, v);
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
  let uv = vec2<f32>(f.x, f.y / aspect) * 0.5 + 0.5;
  if (any(uv < vec2<f32>(0.0)) || any(uv > vec2<f32>(1.0))) {
    discard;
  }
  let texel = textureSampleLevel(decal, decal_sampler, uv, 0.0);
  let alpha = texel.a * smart_mask(p, v);
  if (alpha <= 0.0) {
    discard;
  }
  return vec4<f32>(linear(texel.rgb) * alpha, alpha);
}

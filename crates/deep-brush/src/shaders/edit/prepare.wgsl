// Per-image passes: surface normals from depth and a shading layer from
// luminance. All maps are at the edit resolution except the quarter-size
// luminance used for the large-scale blur.

struct Prepare {
  size: vec2<u32>,
  quarter: vec2<u32>,
  focal: f32,
  sigma: f32,
  white: f32,
  gamma: f32,
  normal_step: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
}

@group(0) @binding(0) var<uniform> u: Prepare;

fn linear(c: vec3<f32>) -> vec3<f32> {
  return select(pow((c + 0.055) / 1.055, vec3<f32>(2.4)), c / 12.92, c <= vec3<f32>(0.04045));
}

fn luminance(c: vec3<f32>) -> f32 {
  return dot(linear(c), vec3<f32>(0.2126, 0.7152, 0.0722));
}

// ---- normals --------------------------------------------------------------

@group(0) @binding(1) var depth_in: texture_2d<f32>;
@group(0) @binding(2) var normal_out: texture_storage_2d<rgba16float, write>;

fn position(p: vec2<i32>) -> vec3<f32> {
  let q = clamp(p, vec2<i32>(0), vec2<i32>(u.size) - 1);
  let z = textureLoad(depth_in, q, 0).r;
  let centre = vec2<f32>(u.size) * 0.5;
  return vec3<f32>((vec2<f32>(q) + 0.5 - centre) * z / u.focal, z);
}

// One-sided differences: on each axis the side whose depth changes least, so a
// pixel beside a depth edge takes its normal from its own surface instead of
// averaging across the silhouette.
fn side(here: vec3<f32>, forward: vec3<f32>, backward: vec3<f32>) -> vec3<f32> {
  let f = forward - here;
  let b = here - backward;
  return select(b, f, abs(f.z) <= abs(b.z));
}

@compute @workgroup_size(8, 8)
fn normals(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (any(gid.xy >= u.size)) {
    return;
  }
  let p = vec2<i32>(gid.xy);
  let s = i32(u.normal_step);
  let here = position(p);
  let dx = side(here, position(p + vec2<i32>(s, 0)), position(p - vec2<i32>(s, 0)));
  let dy = side(here, position(p + vec2<i32>(0, s)), position(p - vec2<i32>(0, s)));
  // Camera space: x right, y down, z forward. The normal faces the camera.
  var n = cross(dy, dx);
  let len = length(n);
  n = select(vec3<f32>(0.0, 0.0, -1.0), n / len, len > 1e-12);
  textureStore(normal_out, p, vec4<f32>(n, 1.0));
}

// ---- shading --------------------------------------------------------------

@group(0) @binding(3) var image: texture_2d<f32>;
@group(0) @binding(4) var lum_out: texture_storage_2d<r32float, write>;
@group(0) @binding(5) var lum_in: texture_2d<f32>;
@group(0) @binding(6) var shading_out: texture_storage_2d<r32float, write>;

@compute @workgroup_size(8, 8)
fn downsample(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (any(gid.xy >= u.quarter)) {
    return;
  }
  var sum = 0.0;
  var count = 0.0;
  for (var y = 0u; y < 4u; y++) {
    for (var x = 0u; x < 4u; x++) {
      let p = gid.xy * 4u + vec2<u32>(x, y);
      if (all(p < u.size)) {
        sum += luminance(textureLoad(image, p, 0).rgb);
        count += 1.0;
      }
    }
  }
  textureStore(lum_out, gid.xy, vec4<f32>(sum / max(count, 1.0)));
}

fn blur(gid: vec2<u32>, axis: vec2<i32>) {
  if (any(gid >= u.quarter)) {
    return;
  }
  let radius = i32(ceil(3.0 * u.sigma));
  var sum = 0.0;
  var weight = 0.0;
  for (var i = -radius; i <= radius; i++) {
    let q = clamp(vec2<i32>(gid) + axis * i, vec2<i32>(0), vec2<i32>(u.quarter) - 1);
    let w = exp(-0.5 * f32(i * i) / (u.sigma * u.sigma));
    sum += w * textureLoad(lum_in, q, 0).r;
    weight += w;
  }
  textureStore(lum_out, gid, vec4<f32>(sum / weight));
}

@compute @workgroup_size(8, 8)
fn blur_x(@builtin(global_invocation_id) gid: vec3<u32>) {
  blur(gid.xy, vec2<i32>(1, 0));
}

@compute @workgroup_size(8, 8)
fn blur_y(@builtin(global_invocation_id) gid: vec3<u32>) {
  blur(gid.xy, vec2<i32>(0, 1));
}

fn blurred(p: vec2<u32>) -> f32 {
  // Bilinear lookup of the quarter-size map at a full-size pixel centre.
  let q = (vec2<f32>(p) + 0.5) / 4.0 - 0.5;
  let base = vec2<i32>(floor(q));
  let t = q - floor(q);
  let hi = vec2<i32>(u.quarter) - 1;
  let a = textureLoad(lum_in, clamp(base, vec2<i32>(0), hi), 0).r;
  let b = textureLoad(lum_in, clamp(base + vec2<i32>(1, 0), vec2<i32>(0), hi), 0).r;
  let c = textureLoad(lum_in, clamp(base + vec2<i32>(0, 1), vec2<i32>(0), hi), 0).r;
  let d = textureLoad(lum_in, clamp(base + vec2<i32>(1, 1), vec2<i32>(0), hi), 0).r;
  return mix(mix(a, b, t.x), mix(c, d, t.x), t.y);
}

// Retinex-style split: detail (L / blurred L) keeps texture and contact
// shadows; the large-scale term (blurred L / white)^gamma keeps part of the
// broad lighting. Not a learned intrinsic decomposition.
@compute @workgroup_size(8, 8)
fn shading(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (any(gid.xy >= u.size)) {
    return;
  }
  let l = luminance(textureLoad(image, gid.xy, 0).rgb);
  let b = max(blurred(gid.xy), 1e-4);
  let s = (l / b) * pow(min(b / u.white, 1.5), u.gamma);
  textureStore(shading_out, gid.xy, vec4<f32>(clamp(s, 0.0, 2.0)));
}

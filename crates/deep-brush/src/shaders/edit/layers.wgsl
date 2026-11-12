// Full-screen passes: merging a stroke into a layer, compositing the
// result, and presenting it.

struct Varyings {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@vertex
fn fullscreen(@builtin(vertex_index) vi: u32) -> Varyings {
  let uv = vec2<f32>(f32((vi << 1u) & 2u), f32(vi & 2u));
  var out: Varyings;
  out.position = vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
  out.uv = uv;
  return out;
}

// ---- commit ---------------------------------------------------------------

struct Commit {
  opacity: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
}

@group(0) @binding(0) var<uniform> commit_u: Commit;
@group(0) @binding(1) var stroke_in: texture_2d<f32>;

// Blend state does the rest: "over" for painting, "dst · (1 − a)" for erasing.
@fragment
fn commit(v: Varyings) -> @location(0) vec4<f32> {
  return textureLoad(stroke_in, vec2<i32>(v.position.xy), 0) * commit_u.opacity;
}

// ---- composite ------------------------------------------------------------

struct Composite {
  light_dir: vec3<f32>,
  view: u32,
  light_intensity: f32,
  ambient: f32,
  use_geometry: f32,
  // 0 none, 1 paint, 2 light, 3 erase paint, 4 erase light
  preview: u32,
  preview_opacity: f32,
  depth_near: f32,
  depth_far: f32,
  _pad: f32,
}

@group(0) @binding(0) var<uniform> c: Composite;
@group(0) @binding(1) var image: texture_2d<f32>;
@group(0) @binding(2) var depth: texture_2d<f32>;
@group(0) @binding(3) var normals: texture_2d<f32>;
@group(0) @binding(4) var shading: texture_2d<f32>;
@group(0) @binding(5) var paint: texture_2d<f32>;
@group(0) @binding(6) var light: texture_2d<f32>;
@group(0) @binding(7) var stroke: texture_2d<f32>;

fn linear(c: vec3<f32>) -> vec3<f32> {
  return select(pow((c + 0.055) / 1.055, vec3<f32>(2.4)), c / 12.92, c <= vec3<f32>(0.04045));
}

fn encode(c: vec3<f32>) -> vec3<f32> {
  let x = clamp(c, vec3<f32>(0.0), vec3<f32>(1.0));
  return select(1.055 * pow(x, vec3<f32>(1.0 / 2.4)) - 0.055, x * 12.92, x <= vec3<f32>(0.0031308));
}

fn over(dst: vec4<f32>, src: vec4<f32>) -> vec4<f32> {
  return src + dst * (1.0 - src.a);
}

@fragment
fn composite(v: Varyings) -> @location(0) vec4<f32> {
  let p = vec2<i32>(v.position.xy);
  let original = textureLoad(image, p, 0).rgb;
  let n = textureLoad(normals, p, 0).xyz;
  let s = textureLoad(shading, p, 0).r;
  switch c.view {
    case 1u: {
      return vec4<f32>(original, 1.0);
    }
    case 2u: {
      let z = textureLoad(depth, p, 0).r;
      // Inverse depth, near is bright.
      let t = (1.0 / z - 1.0 / c.depth_far) / (1.0 / c.depth_near - 1.0 / c.depth_far);
      return vec4<f32>(vec3<f32>(clamp(t, 0.0, 1.0)), 1.0);
    }
    case 3u: {
      // x right, y up, z towards the viewer.
      return vec4<f32>(vec3<f32>(n.x, -n.y, -n.z) * 0.5 + 0.5, 1.0);
    }
    case 4u: {
      return vec4<f32>(encode(vec3<f32>(s * 0.5)), 1.0);
    }
    default: {}
  }

  var layer = textureLoad(paint, p, 0);
  var lit_layer = textureLoad(light, p, 0);
  let st = textureLoad(stroke, p, 0) * c.preview_opacity;
  switch c.preview {
    case 1u: { layer = over(layer, st); }
    case 2u: { lit_layer = over(lit_layer, st); }
    case 3u: { layer = layer * (1.0 - st.a); }
    case 4u: { lit_layer = lit_layer * (1.0 - st.a); }
    default: {}
  }

  let i = linear(original);
  let albedo_estimate = min(i / max(s, 0.04), vec3<f32>(1.0));
  let albedo = albedo_estimate * (1.0 - layer.a) + layer.rgb;
  if (c.view == 5u) {
    return vec4<f32>(encode(albedo), 1.0);
  }
  let base = i * (1.0 - layer.a) + layer.rgb * s;
  var lambert = 1.0;
  if (c.use_geometry > 0.5) {
    lambert = max(dot(n, c.light_dir), 0.0);
  }
  let added = albedo * lit_layer.rgb * c.light_intensity * lambert;
  return vec4<f32>(encode(base * c.ambient + added), 1.0);
}

// ---- present --------------------------------------------------------------

@group(0) @binding(0) var result: texture_2d<f32>;
@group(0) @binding(1) var result_sampler: sampler;

@fragment
fn present(v: Varyings) -> @location(0) vec4<f32> {
  return vec4<f32>(textureSampleLevel(result, result_sampler, v.uv, 0.0).rgb, 1.0);
}

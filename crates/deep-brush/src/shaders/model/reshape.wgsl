// Layout and resampling kernels for the DPT neck. Each entry point has its
// own bindings; the pipeline is built once per entry point.

struct Params {
  a: u32,
  b: u32,
  c: u32,
  d: u32,
  e: u32,
  f: u32,
  g: u32,
  h: u32,
}

@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> src: array<f32>;
@group(0) @binding(2) var<storage, read> aux_a: array<f32>;
@group(0) @binding(3) var<storage, read> aux_b: array<f32>;
@group(0) @binding(4) var<storage, read_write> dst: array<f32>;

// Patch embedding → tokens. a = patches, b = channels.
// dst[0] = cls + pos[0]; dst[1 + i] = src[:, i] + pos[1 + i].
// aux_a = class token, aux_b = position embeddings.
@compute @workgroup_size(16, 16)
fn embed(@builtin(global_invocation_id) gid: vec3<u32>) {
  let channel = gid.x;
  let token = gid.y;
  if (channel >= p.b || token > p.a) {
    return;
  }
  var v = aux_a[channel];
  if (token > 0u) {
    v = src[channel * p.a + token - 1u];
  }
  dst[token * p.b + channel] = v + aux_b[token * p.b + channel];
}

// Tokens [1 + patches, channels] → CHW, dropping the class token.
// a = patches, b = channels.
@compute @workgroup_size(16, 16)
fn tokens_to_chw(@builtin(global_invocation_id) gid: vec3<u32>) {
  let cell = gid.x;
  let channel = gid.y;
  if (cell >= p.a || channel >= p.b) {
    return;
  }
  dst[channel * p.a + cell] = src[(cell + 1u) * p.b + channel];
}

// ConvTranspose2d with kernel == stride and no padding.
// a = cin, b = hin, c = win, d = cout, e = k. aux_a = weight [cin, cout, k, k], aux_b = bias.
@compute @workgroup_size(8, 8, 1)
fn conv_transpose(@builtin(global_invocation_id) gid: vec3<u32>) {
  let k = p.e;
  let wout = p.c * k;
  let hout = p.b * k;
  let x = gid.x;
  let y = gid.y;
  let oc = gid.z;
  if (x >= wout || y >= hout || oc >= p.d) {
    return;
  }
  let ix = x / k;
  let iy = y / k;
  let tap = (y % k) * k + (x % k);
  var v = aux_b[oc];
  for (var ic = 0u; ic < p.a; ic++) {
    v = fma(src[(ic * p.b + iy) * p.c + ix], aux_a[(ic * p.d + oc) * k * k + tap], v);
  }
  dst[(oc * hout + y) * wout + x] = v;
}

// Bilinear resize of CHW maps with PyTorch's index rules.
// a = channels, b = hin, c = win, d = hout, e = wout, f = align_corners.
fn src_coord(o: u32, n_in: u32, n_out: u32, align: bool) -> f32 {
  if (align) {
    if (n_out <= 1u) {
      return 0.0;
    }
    return f32(o) * f32(n_in - 1u) / f32(n_out - 1u);
  }
  return max((f32(o) + 0.5) * f32(n_in) / f32(n_out) - 0.5, 0.0);
}

@compute @workgroup_size(8, 8, 1)
fn resize(@builtin(global_invocation_id) gid: vec3<u32>) {
  let x = gid.x;
  let y = gid.y;
  let c = gid.z;
  if (x >= p.e || y >= p.d || c >= p.a) {
    return;
  }
  let align = p.f != 0u;
  let sy = src_coord(y, p.b, p.d, align);
  let sx = src_coord(x, p.c, p.e, align);
  let y0 = min(u32(floor(sy)), p.b - 1u);
  let x0 = min(u32(floor(sx)), p.c - 1u);
  let y1 = min(y0 + 1u, p.b - 1u);
  let x1 = min(x0 + 1u, p.c - 1u);
  let ly = sy - f32(y0);
  let lx = sx - f32(x0);
  let base = c * p.b * p.c;
  let top = mix(src[base + y0 * p.c + x0], src[base + y0 * p.c + x1], lx);
  let bottom = mix(src[base + y1 * p.c + x0], src[base + y1 * p.c + x1], lx);
  dst[(c * p.d + y) * p.e + x] = mix(top, bottom, ly);
}

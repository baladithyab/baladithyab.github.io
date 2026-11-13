// Direct NCHW convolution; each thread computes four output channels at one
// pixel. Flags: 1 bias, 2 ReLU on the input, 4 ReLU on the output,
// 8 add res_a, 16 add res_b (both shaped like the output).

struct Params {
  cin: u32,
  hin: u32,
  win: u32,
  cout: u32,
  hout: u32,
  wout: u32,
  kh: u32,
  kw: u32,
  stride: u32,
  pad: u32,
  flags: u32,
  _pad: u32,
}

@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> input: array<f32>;
@group(0) @binding(2) var<storage, read> weight: array<f32>;
@group(0) @binding(3) var<storage, read> bias: array<f32>;
@group(0) @binding(4) var<storage, read> res_a: array<f32>;
@group(0) @binding(5) var<storage, read> res_b: array<f32>;
@group(0) @binding(6) var<storage, read_write> output: array<f32>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let x = gid.x;
  let y = gid.y;
  let oc0 = gid.z * 4u;
  if (x >= p.wout || y >= p.hout) {
    return;
  }
  let relu_in = (p.flags & 2u) != 0u;
  let taps = p.kh * p.kw;
  let per_out = p.cin * taps;
  let lanes = min(4u, p.cout - oc0);
  var acc = vec4<f32>(0.0);
  for (var ic = 0u; ic < p.cin; ic++) {
    for (var ky = 0u; ky < p.kh; ky++) {
      let iy = i32(y * p.stride + ky) - i32(p.pad);
      if (iy < 0 || iy >= i32(p.hin)) {
        continue;
      }
      for (var kx = 0u; kx < p.kw; kx++) {
        let ix = i32(x * p.stride + kx) - i32(p.pad);
        if (ix < 0 || ix >= i32(p.win)) {
          continue;
        }
        var v = input[(ic * p.hin + u32(iy)) * p.win + u32(ix)];
        if (relu_in) {
          v = max(v, 0.0);
        }
        let tap = ic * taps + ky * p.kw + kx;
        var wv = vec4<f32>(0.0);
        for (var j = 0u; j < lanes; j++) {
          wv[j] = weight[(oc0 + j) * per_out + tap];
        }
        acc = fma(vec4<f32>(v), wv, acc);
      }
    }
  }
  let plane = p.hout * p.wout;
  for (var j = 0u; j < lanes; j++) {
    let oc = oc0 + j;
    let at = oc * plane + y * p.wout + x;
    var v = acc[j];
    if ((p.flags & 1u) != 0u) {
      v += bias[oc];
    }
    if ((p.flags & 4u) != 0u) {
      v = max(v, 0.0);
    }
    if ((p.flags & 8u) != 0u) {
      v += res_a[at];
    }
    if ((p.flags & 16u) != 0u) {
      v += res_b[at];
    }
    output[at] = v;
  }
}

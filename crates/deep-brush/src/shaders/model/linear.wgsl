// y[m, n] = x[m, k] · w[n, k]ᵀ + bias[n], with an optional epilogue:
//   1: exact GELU
//   2: residual[m, n] + scale[n] · (…)   (DINOv2 layer scale)

struct Params {
  m: u32,
  n: u32,
  k: u32,
  epilogue: u32,
}

@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> x: array<f32>;
@group(0) @binding(2) var<storage, read> w: array<f32>;
@group(0) @binding(3) var<storage, read> bias: array<f32>;
@group(0) @binding(4) var<storage, read> scale: array<f32>;
@group(0) @binding(5) var<storage, read> residual: array<f32>;
@group(0) @binding(6) var<storage, read_write> y: array<f32>;

const TILE: u32 = 64u;
const KT: u32 = 16u;

// k-major tiles: [KT][TILE]
var<workgroup> xs: array<f32, 1024>;
var<workgroup> ws: array<f32, 1024>;

// Abramowitz & Stegun 7.1.26, |error| < 1.5e-7.
fn erf(v: f32) -> f32 {
  let s = sign(v);
  let a = abs(v);
  let t = 1.0 / (1.0 + 0.3275911 * a);
  let poly = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  return s * (1.0 - poly * exp(-a * a));
}

@compute @workgroup_size(16, 16)
fn main(
  @builtin(workgroup_id) wg: vec3<u32>,
  @builtin(local_invocation_id) lid: vec3<u32>,
  @builtin(local_invocation_index) li: u32,
) {
  let row0 = wg.y * TILE;
  let col0 = wg.x * TILE;
  var acc: array<array<f32, 4>, 4>;
  for (var k0 = 0u; k0 < p.k; k0 += KT) {
    for (var i = 0u; i < 4u; i++) {
      let e = li + i * 256u;
      let r = e / KT;
      let kk = e % KT;
      let gk = k0 + kk;
      let gr = row0 + r;
      var xv = 0.0;
      if (gr < p.m && gk < p.k) {
        xv = x[gr * p.k + gk];
      }
      xs[kk * TILE + r] = xv;
      let gc = col0 + r;
      var wv = 0.0;
      if (gc < p.n && gk < p.k) {
        wv = w[gc * p.k + gk];
      }
      ws[kk * TILE + r] = wv;
    }
    workgroupBarrier();
    for (var kk = 0u; kk < KT; kk++) {
      let xa = vec4<f32>(
        xs[kk * TILE + lid.y * 4u],
        xs[kk * TILE + lid.y * 4u + 1u],
        xs[kk * TILE + lid.y * 4u + 2u],
        xs[kk * TILE + lid.y * 4u + 3u],
      );
      let wb = vec4<f32>(
        ws[kk * TILE + lid.x * 4u],
        ws[kk * TILE + lid.x * 4u + 1u],
        ws[kk * TILE + lid.x * 4u + 2u],
        ws[kk * TILE + lid.x * 4u + 3u],
      );
      for (var i = 0u; i < 4u; i++) {
        for (var j = 0u; j < 4u; j++) {
          acc[i][j] = fma(xa[i], wb[j], acc[i][j]);
        }
      }
    }
    workgroupBarrier();
  }
  for (var i = 0u; i < 4u; i++) {
    let row = row0 + lid.y * 4u + i;
    if (row >= p.m) {
      continue;
    }
    for (var j = 0u; j < 4u; j++) {
      let col = col0 + lid.x * 4u + j;
      if (col >= p.n) {
        continue;
      }
      var v = acc[i][j] + bias[col];
      if (p.epilogue == 1u) {
        v = 0.5 * v * (1.0 + erf(v * 0.70710678118));
      } else if (p.epilogue == 2u) {
        v = residual[row * p.n + col] + scale[col] * v;
      }
      y[row * p.n + col] = v;
    }
  }
}

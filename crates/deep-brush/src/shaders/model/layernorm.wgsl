// Row-wise LayerNorm over the last dimension; one workgroup per row.

struct Params {
  rows: u32,
  cols: u32,
  eps: f32,
  _pad: u32,
}

@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> x: array<f32>;
@group(0) @binding(2) var<storage, read> gamma: array<f32>;
@group(0) @binding(3) var<storage, read> beta: array<f32>;
@group(0) @binding(4) var<storage, read_write> y: array<f32>;

const THREADS: u32 = 128u;
var<workgroup> red: array<f32, 128>;

fn reduce(lane: u32) -> f32 {
  for (var s = THREADS / 2u; s > 0u; s >>= 1u) {
    if (lane < s) {
      red[lane] += red[lane + s];
    }
    workgroupBarrier();
  }
  return red[0];
}

@compute @workgroup_size(128)
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let row = wg.x;
  // Out-of-range workgroups still take part in the barriers.
  let live = row < p.rows;
  let base = row * p.cols;
  var sum = 0.0;
  if (live) {
    for (var i = lid.x; i < p.cols; i += THREADS) {
      sum += x[base + i];
    }
  }
  red[lid.x] = sum;
  workgroupBarrier();
  let mean = reduce(lid.x) / f32(p.cols);
  workgroupBarrier();
  var sq = 0.0;
  if (live) {
    for (var i = lid.x; i < p.cols; i += THREADS) {
      let d = x[base + i] - mean;
      sq += d * d;
    }
  }
  red[lid.x] = sq;
  workgroupBarrier();
  let inv = inverseSqrt(reduce(lid.x) / f32(p.cols) + p.eps);
  if (live) {
    for (var i = lid.x; i < p.cols; i += THREADS) {
      y[base + i] = (x[base + i] - mean) * inv * gamma[i] + beta[i];
    }
  }
}

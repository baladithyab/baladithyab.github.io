// Multi-head self-attention over packed qkv rows [tokens, 3·heads·64].
// One thread per query; keys and values stream through workgroup memory in
// blocks of 16 with an online softmax, so the score matrix never exists.
// Loops have constant trip counts and vectors are vec4 so that the query,
// accumulator and scores stay in registers.

struct Params {
  tokens: u32,
  heads: u32,
  scale: f32,
  _pad: u32,
}

@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> qkv: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> out: array<vec4<f32>>;

// Head width in vec4s.
const D4: u32 = 16u;
const KB: u32 = 16u;
const Q: u32 = 64u;

var<workgroup> ks: array<vec4<f32>, 256>;
var<workgroup> vs: array<vec4<f32>, 256>;

@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let head = wg.y;
  let width = p.heads * D4;
  let stride = 3u * width;
  let query = wg.x * Q + lid.x;
  let live = query < p.tokens;

  var q: array<vec4<f32>, 16>;
  var acc: array<vec4<f32>, 16>;
  if (live) {
    for (var d = 0u; d < D4; d++) {
      q[d] = qkv[query * stride + head * D4 + d] * p.scale;
    }
  }
  var running_max = -3.0e38;
  var total = 0.0;

  for (var k0 = 0u; k0 < p.tokens; k0 += KB) {
    for (var i = 0u; i < 4u; i++) {
      let e = lid.x + i * Q;
      let key = k0 + e / D4;
      let d = e % D4;
      var kv = vec4<f32>(0.0);
      var vv = vec4<f32>(0.0);
      if (key < p.tokens) {
        kv = qkv[key * stride + width + head * D4 + d];
        vv = qkv[key * stride + 2u * width + head * D4 + d];
      }
      ks[e] = kv;
      vs[e] = vv;
    }
    workgroupBarrier();
    var scores: array<f32, 16>;
    var block_max = running_max;
    for (var j = 0u; j < KB; j++) {
      var dots = vec4<f32>(0.0);
      for (var d = 0u; d < D4; d++) {
        dots = fma(q[d], ks[j * D4 + d], dots);
      }
      let s = select(-3.0e38, dots.x + dots.y + dots.z + dots.w, k0 + j < p.tokens);
      scores[j] = s;
      block_max = max(block_max, s);
    }
    let correction = exp(running_max - block_max);
    total *= correction;
    for (var d = 0u; d < D4; d++) {
      acc[d] *= correction;
    }
    for (var j = 0u; j < KB; j++) {
      let weight = exp(scores[j] - block_max);
      total += weight;
      for (var d = 0u; d < D4; d++) {
        acc[d] = fma(vec4<f32>(weight), vs[j * D4 + d], acc[d]);
      }
    }
    running_max = block_max;
    workgroupBarrier();
  }

  if (live) {
    let inv = 1.0 / total;
    for (var d = 0u; d < D4; d++) {
      out[query * width + head * D4 + d] = acc[d] * inv;
    }
  }
}

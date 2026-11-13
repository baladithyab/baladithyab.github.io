//! Camera-space surface geometry from relative depth, on the CPU. The brush
//! uses it to anchor each dab; the shaders recompute the same quantities per
//! pixel from the depth texture.

pub type V3 = [f32; 3];

pub fn add(a: V3, b: V3) -> V3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
pub fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
pub fn scale(a: V3, s: f32) -> V3 {
    [a[0] * s, a[1] * s, a[2] * s]
}
pub fn dot(a: V3, b: V3) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
pub fn cross(a: V3, b: V3) -> V3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}
pub fn normalize(a: V3) -> V3 {
    let len = dot(a, a).sqrt();
    if len < 1e-12 {
        [0.0, 0.0, -1.0]
    } else {
        scale(a, 1.0 / len)
    }
}

/// Depth spans `NEAR_DEPTH..FAR_DEPTH` after normalizing disparity. The model
/// predicts disparity up to an unknown scale and shift, so this ratio is a
/// choice, not a measurement. Depth is 1 / disparity, so the far end
/// magnifies the model's noise and bias by up to (FAR / NEAR)²; at 10:1
/// that tilted the normals of distant walls by tens of degrees.
pub const NEAR_DEPTH: f32 = 1.0;
pub const FAR_DEPTH: f32 = 4.0;
/// Horizontal field of view assumed for the longer image side.
const FIELD_OF_VIEW_DEG: f32 = 60.0;

pub struct Geometry {
    pub width: usize,
    pub height: usize,
    pub focal: f32,
    /// Camera-space depth per pixel, row-major.
    pub depth: Vec<f32>,
}

impl Geometry {
    fn focal_for(width: usize, height: usize) -> f32 {
        0.5 * width.max(height) as f32 / (0.5 * FIELD_OF_VIEW_DEG.to_radians()).tan()
    }

    /// A fronto-parallel plane: what the brush sees before depth exists.
    pub fn flat(width: usize, height: usize) -> Self {
        let depth = vec![(NEAR_DEPTH * FAR_DEPTH).sqrt(); width * height];
        Self {
            width,
            height,
            focal: Self::focal_for(width, height),
            depth,
        }
    }

    /// Converts model-resolution disparity into depth at the edit resolution.
    ///
    /// Depth edges decide where an occluder ends, so they are kept sharp:
    /// an edge-preserving filter removes texel ripple at the model
    /// resolution, and the upsampling is guided by the photo (`rgba`, the
    /// edit-resolution pixels) wherever the depth changes, so a silhouette
    /// lands on the image edge instead of a blurred band around it.
    pub fn from_disparity(
        disparity: &[f32],
        dw: usize,
        dh: usize,
        rgba: &[u8],
        width: usize,
        height: usize,
    ) -> Self {
        let disparity = bilateral(disparity, dw, dh);
        let mut sorted: Vec<f32> = disparity.iter().step_by(7).copied().collect();
        sorted.sort_by(f32::total_cmp);
        let at = |q: f32| sorted[((sorted.len() - 1) as f32 * q) as usize];
        let (lo, hi) = (at(0.01), at(0.99));
        let span = (hi - lo).max(1e-6);
        let normalized: Vec<f32> = disparity
            .iter()
            .map(|d| ((d - lo) / span).clamp(0.0, 1.0))
            .collect();
        let upsampled = guided_upsample(&normalized, dw, dh, rgba, width, height);
        let near = NEAR_DEPTH / FAR_DEPTH;
        let depth = upsampled
            .iter()
            .map(|t| NEAR_DEPTH / (near + (1.0 - near) * t))
            .collect();
        Self {
            width,
            height,
            focal: Self::focal_for(width, height),
            depth,
        }
    }

    pub fn ray(&self, x: f32, y: f32) -> V3 {
        [
            (x - 0.5 * self.width as f32) / self.focal,
            (y - 0.5 * self.height as f32) / self.focal,
            1.0,
        ]
    }

    /// Depth of the pixel containing `(x, y)`, matching the shaders' lookup.
    pub fn depth_at(&self, x: f32, y: f32) -> f32 {
        let px = (x.floor() as isize).clamp(0, self.width as isize - 1) as usize;
        let py = (y.floor() as isize).clamp(0, self.height as isize - 1) as usize;
        self.depth[py * self.width + px]
    }

    pub fn position(&self, x: f32, y: f32) -> V3 {
        scale(self.ray(x, y), self.depth_at(x, y))
    }

    /// Surface normal facing the camera from one-sided differences `step` px
    /// long. On each axis the side whose depth changes least is used, so a
    /// pixel beside a depth edge takes its normal from its own surface.
    pub fn normal(&self, x: f32, y: f32, step: f32) -> V3 {
        let here = self.position(x, y);
        let side = |a: V3, b: V3| {
            let forward = sub(a, here);
            let backward = sub(here, b);
            if forward[2].abs() <= backward[2].abs() {
                forward
            } else {
                backward
            }
        };
        let dx = side(self.position(x + step, y), self.position(x - step, y));
        let dy = side(self.position(x, y + step), self.position(x, y - step));
        normalize(cross(dy, dx))
    }

    /// Pixel step for normals: wide enough to span an upsampled model texel.
    pub fn normal_step(&self, model_long_side: usize) -> f32 {
        let ratio = self.width.max(self.height) as f32 / model_long_side.max(1) as f32;
        (ratio * 1.5).ceil().max(2.0)
    }
}

/// Edge-preserving smoothing at the model resolution (5 × 5 bilateral,
/// σ = 1.2 texels, range σ = 2 % of the robust disparity span). Removes the
/// texel ripple that shows up in normals without moving object boundaries.
fn bilateral(values: &[f32], width: usize, height: usize) -> Vec<f32> {
    const RADIUS: isize = 2;
    const SIGMA: f32 = 1.2;
    let mut sorted: Vec<f32> = values.iter().step_by(11).copied().collect();
    sorted.sort_by(f32::total_cmp);
    let span = (sorted[(sorted.len() - 1) * 99 / 100] - sorted[(sorted.len() - 1) / 100]).max(1e-6);
    let inv_range = 1.0 / (2.0 * (0.02 * span).powi(2));
    let mut out = vec![0f32; values.len()];
    for y in 0..height as isize {
        for x in 0..width as isize {
            let centre = values[y as usize * width + x as usize];
            let (mut acc, mut total) = (0.0, 0.0);
            for oy in -RADIUS..=RADIUS {
                let sy = (y + oy).clamp(0, height as isize - 1) as usize;
                for ox in -RADIUS..=RADIUS {
                    let sx = (x + ox).clamp(0, width as isize - 1) as usize;
                    let v = values[sy * width + sx];
                    let spatial = -((ox * ox + oy * oy) as f32) / (2.0 * SIGMA * SIGMA);
                    let w = (spatial - (v - centre).powi(2) * inv_range).exp();
                    acc += w * v;
                    total += w;
                }
            }
            out[y as usize * width + x as usize] = acc / total;
        }
    }
    out
}

/// Upsamples `low` (normalized disparity, `lw × lh`) to `width × height`.
///
/// Bilinear where the 3 × 3 neighbourhood is flat. Near depth edges, a joint
/// bilateral upsample (Kopf et al. 2007) over the surrounding 8 × 8 texels,
/// weighted by distance, by how close each texel's mean colour is to the
/// output pixel's colour, and by how flat the texel is. The last weight
/// matters because a monocular model blurs its own edges over a few texels:
/// texels in that band hold neither surface's depth, so a pixel takes its
/// depth from clean texels of its own colour instead. Where no flat texel
/// matches (structures thinner than the band), colour alone decides.
fn guided_upsample(
    low: &[f32],
    lw: usize,
    lh: usize,
    rgba: &[u8],
    width: usize,
    height: usize,
) -> Vec<f32> {
    const EDGE: f32 = 0.03;
    const SPATIAL_SIGMA: f32 = 1.5;
    const COLOR_SIGMA: f32 = 0.07;
    const FLAT_SIGMA: f32 = 0.015;
    let sx = lw as f32 / width as f32;
    let sy = lh as f32 / height as f32;
    let texel = |x: isize, y: isize| {
        (y.clamp(0, lh as isize - 1) as usize) * lw + x.clamp(0, lw as isize - 1) as usize
    };

    // Texels with depth variation nearby; only those need the guided path.
    let mut edge = vec![false; lw * lh];
    for y in 0..lh as isize {
        for x in 0..lw as isize {
            let (mut lo, mut hi) = (f32::MAX, f32::MIN);
            for oy in -1..=1 {
                for ox in -1..=1 {
                    let v = low[texel(x + ox, y + oy)];
                    lo = lo.min(v);
                    hi = hi.max(v);
                }
            }
            edge[y as usize * lw + x as usize] = hi - lo > EDGE;
        }
    }

    // Steepness per texel: the smaller one-sided difference on each axis, so
    // a texel just outside the blurred band still counts as flat.
    let mut steep = vec![0f32; lw * lh];
    for y in 0..lh as isize {
        for x in 0..lw as isize {
            let v = low[texel(x, y)];
            let along = |dx: isize, dy: isize| {
                (low[texel(x + dx, y + dy)] - v)
                    .abs()
                    .min((v - low[texel(x - dx, y - dy)]).abs())
            };
            steep[y as usize * lw + x as usize] = along(1, 0).max(along(0, 1));
        }
    }

    // Mean colour of the edit pixels each texel covers.
    let mut guide = vec![[0f32; 3]; lw * lh];
    let mut counts = vec![0u32; lw * lh];
    for y in 0..height {
        let ty = ((y as f32 + 0.5) * sy) as usize;
        for x in 0..width {
            let t = ty.min(lh - 1) * lw + (((x as f32 + 0.5) * sx) as usize).min(lw - 1);
            let i = (y * width + x) * 4;
            for c in 0..3 {
                guide[t][c] += rgba[i + c] as f32 / 255.0;
            }
            counts[t] += 1;
        }
    }
    for (g, &n) in guide.iter_mut().zip(&counts) {
        let n = n.max(1) as f32;
        g.iter_mut().for_each(|c| *c /= n);
    }

    let inv_spatial = 1.0 / (2.0 * SPATIAL_SIGMA * SPATIAL_SIGMA);
    let inv_color = 1.0 / (2.0 * COLOR_SIGMA * COLOR_SIGMA);
    let inv_flat = 1.0 / (2.0 * FLAT_SIGMA * FLAT_SIGMA);
    let mut out = vec![0f32; width * height];
    for y in 0..height {
        let fy = ((y as f32 + 0.5) * sy - 0.5).clamp(0.0, (lh - 1) as f32);
        let y0 = fy as isize;
        let ty = fy - y0 as f32;
        for x in 0..width {
            let fx = ((x as f32 + 0.5) * sx - 0.5).clamp(0.0, (lw - 1) as f32);
            let x0 = fx as isize;
            let tx = fx - x0 as f32;
            let near_edge = edge[texel(x0, y0)]
                || edge[texel(x0 + 1, y0)]
                || edge[texel(x0, y0 + 1)]
                || edge[texel(x0 + 1, y0 + 1)];
            out[y * width + x] = if near_edge {
                let i = (y * width + x) * 4;
                let colour = [0, 1, 2].map(|c| rgba[i + c] as f32 / 255.0);
                let (mut acc, mut total) = (0.0, 0.0);
                let (mut acc_colour, mut total_colour) = (0.0, 0.0);
                for oy in -3..=4 {
                    for ox in -3..=4 {
                        let t = texel(x0 + ox, y0 + oy);
                        let dx = ox as f32 - tx;
                        let dy = oy as f32 - ty;
                        let g = guide[t];
                        let dc = (0..3).map(|c| (g[c] - colour[c]).powi(2)).sum::<f32>();
                        let w = (-(dx * dx + dy * dy) * inv_spatial - dc * inv_color).exp();
                        acc_colour += w * low[t];
                        total_colour += w;
                        let flat = w * (-steep[t] * steep[t] * inv_flat).exp();
                        acc += flat * low[t];
                        total += flat;
                    }
                }
                if total > 1e-6 {
                    acc / total
                } else if total_colour > 1e-12 {
                    acc_colour / total_colour
                } else {
                    low[texel(x0, y0)]
                }
            } else {
                let top = low[texel(x0, y0)] * (1.0 - tx) + low[texel(x0 + 1, y0)] * tx;
                let bottom = low[texel(x0, y0 + 1)] * (1.0 - tx) + low[texel(x0 + 1, y0 + 1)] * tx;
                top * (1.0 - ty) + bottom * ty
            };
        }
    }
    out
}

/// Tangent and bitangent on the plane with normal `n`, aligned with the
/// image axes and then rotated by `angle`. The bitangent points down the
/// image so decals stay upright.
pub fn tangent_frame(n: V3, angle: f32) -> (V3, V3) {
    let mut t = sub([1.0, 0.0, 0.0], scale(n, n[0]));
    if dot(t, t) < 1e-6 {
        t = sub([0.0, 1.0, 0.0], scale(n, n[1]));
    }
    let t0 = normalize(t);
    let b0 = normalize(cross(t0, n));
    let (s, c) = angle.sin_cos();
    (
        add(scale(t0, c), scale(b0, s)),
        sub(scale(b0, c), scale(t0, s)),
    )
}

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
    pub fn from_disparity(
        disparity: &[f32],
        dw: usize,
        dh: usize,
        width: usize,
        height: usize,
    ) -> Self {
        let disparity = smooth(disparity, dw, dh);
        let mut sorted: Vec<f32> = disparity.iter().step_by(7).copied().collect();
        sorted.sort_by(f32::total_cmp);
        let at = |q: f32| sorted[((sorted.len() - 1) as f32 * q) as usize];
        let (lo, hi) = (at(0.01), at(0.99));
        let span = (hi - lo).max(1e-6);
        let near = NEAR_DEPTH / FAR_DEPTH;
        let to_depth = |d: f32| {
            let t = ((d - lo) / span).clamp(0.0, 1.0);
            NEAR_DEPTH / (near + (1.0 - near) * t)
        };
        let mut depth = vec![0f32; width * height];
        let sx = dw as f32 / width as f32;
        let sy = dh as f32 / height as f32;
        for y in 0..height {
            let fy = ((y as f32 + 0.5) * sy - 0.5).clamp(0.0, (dh - 1) as f32);
            let y0 = fy as usize;
            let y1 = (y0 + 1).min(dh - 1);
            let ty = fy - y0 as f32;
            for x in 0..width {
                let fx = ((x as f32 + 0.5) * sx - 0.5).clamp(0.0, (dw - 1) as f32);
                let x0 = fx as usize;
                let x1 = (x0 + 1).min(dw - 1);
                let tx = fx - x0 as f32;
                let top = disparity[y0 * dw + x0] * (1.0 - tx) + disparity[y0 * dw + x1] * tx;
                let bottom = disparity[y1 * dw + x0] * (1.0 - tx) + disparity[y1 * dw + x1] * tx;
                depth[y * width + x] = to_depth(top * (1.0 - ty) + bottom * ty);
            }
        }
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

    /// Surface normal facing the camera, from central differences `step` px apart.
    pub fn normal(&self, x: f32, y: f32, step: f32) -> V3 {
        let dx = sub(self.position(x + step, y), self.position(x - step, y));
        let dy = sub(self.position(x, y + step), self.position(x, y - step));
        normalize(cross(dy, dx))
    }

    /// Pixel step for normals: wide enough to span an upsampled model texel.
    pub fn normal_step(&self, model_long_side: usize) -> f32 {
        let ratio = self.width.max(self.height) as f32 / model_long_side.max(1) as f32;
        (ratio * 1.5).ceil().max(2.0)
    }
}

/// Separable Gaussian (σ = 1.2 px) at the model resolution. Removes the
/// texel-level ripple that would otherwise show up in normals.
fn smooth(values: &[f32], width: usize, height: usize) -> Vec<f32> {
    const SIGMA: f32 = 1.2;
    const RADIUS: isize = 3;
    let weights: Vec<f32> = (-RADIUS..=RADIUS)
        .map(|i| (-0.5 * (i * i) as f32 / (SIGMA * SIGMA)).exp())
        .collect();
    let total: f32 = weights.iter().sum();
    let pass = |src: &[f32], dx: isize, dy: isize| -> Vec<f32> {
        let mut out = vec![0f32; src.len()];
        for y in 0..height as isize {
            for x in 0..width as isize {
                let mut acc = 0.0;
                for (k, w) in weights.iter().enumerate() {
                    let o = k as isize - RADIUS;
                    let sx = (x + o * dx).clamp(0, width as isize - 1) as usize;
                    let sy = (y + o * dy).clamp(0, height as isize - 1) as usize;
                    acc += w * src[sy * width + sx];
                }
                out[y as usize * width + x as usize] = acc / total;
            }
        }
        out
    };
    pass(&pass(values, 1, 0), 0, 1)
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

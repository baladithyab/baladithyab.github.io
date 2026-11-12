//! Connected surfaces are computed once per depth map, never by following
//! the pointer. A stroke keeps the surface ID it started on for its lifetime.

use crate::geometry::{Geometry, dot};

pub(crate) struct Surfaces {
    pub ids: Vec<u32>,
    width: usize,
    height: usize,
}

impl Surfaces {
    pub fn flat(width: usize, height: usize) -> Self {
        Self {
            ids: vec![1; width * height],
            width,
            height,
        }
    }
    pub fn new(geometry: &Geometry, step: usize) -> Self {
        let (width, height) = (geometry.width, geometry.height);
        let mut edges = vec![0u8; width * height];
        let at = |x: usize, y: usize| geometry.depth[y * width + x];
        let normals: Vec<_> = (0..width * height)
            .map(|i| {
                geometry.normal(
                    (i % width) as f32 + 0.5,
                    (i / width) as f32 + 0.5,
                    step as f32,
                )
            })
            .collect();
        let bend_step = step * 3;
        let normal_at = |x: usize, y: usize| normals[y * width + x];
        let separated = |a: f32, b: f32| (a - b).abs() > 0.1 * a.min(b);
        for y in 0..height {
            for x in 0..width {
                let i = y * width + x;
                if x + 1 < width
                    && separated(
                        at(x.saturating_sub(step), y),
                        at((x + 1 + step).min(width - 1), y),
                    )
                    || x + 1 < width
                        && dot(
                            normal_at(x.saturating_sub(bend_step), y),
                            normal_at((x + 1 + bend_step).min(width - 1), y),
                        ) < 0.6
                {
                    edges[i] |= 1;
                }
                if y + 1 < height
                    && separated(
                        at(x, y.saturating_sub(step)),
                        at(x, (y + 1 + step).min(height - 1)),
                    )
                    || y + 1 < height
                        && dot(
                            normal_at(x, y.saturating_sub(bend_step)),
                            normal_at(x, (y + 1 + bend_step).min(height - 1)),
                        ) < 0.6
                {
                    edges[i] |= 2;
                }
            }
        }
        let mut ids = vec![0u32; edges.len()];
        let mut queue = Vec::new();
        let mut id = 0;
        for seed in 0..ids.len() {
            if ids[seed] != 0 {
                continue;
            }
            id += 1;
            ids[seed] = id;
            queue.clear();
            queue.push(seed);
            let mut head = 0;
            while head < queue.len() {
                let i = queue[head];
                head += 1;
                let (x, y) = (i % width, i / width);
                let mut visit = |next: usize| {
                    if ids[next] == 0 {
                        ids[next] = id;
                        queue.push(next);
                    }
                };
                if x > 0 && edges[i - 1] & 1 == 0 {
                    visit(i - 1);
                }
                if x + 1 < width && edges[i] & 1 == 0 {
                    visit(i + 1);
                }
                if y > 0 && edges[i - width] & 2 == 0 {
                    visit(i - width);
                }
                if y + 1 < height && edges[i] & 2 == 0 {
                    visit(i + width);
                }
            }
        }
        Self { ids, width, height }
    }

    pub fn at(&self, x: f32, y: f32) -> u32 {
        let x = (x.floor() as isize).clamp(0, self.width as isize - 1) as usize;
        let y = (y.floor() as isize).clamp(0, self.height as isize - 1) as usize;
        self.ids[y * self.width + x]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn separates_smoothed_occluder_and_rejoins_wall_on_far_side() {
        let (w, h) = (160, 80);
        let mut disparity = vec![0.0; w * h];
        for y in 16..64 {
            for x in 60..100 {
                disparity[y * w + x] = 1.0;
            }
        }
        let g = Geometry::from_disparity(&disparity, w, h, w, h);
        let surfaces = Surfaces::new(&g, 2);
        assert_eq!(surfaces.at(20.0, 40.0), surfaces.at(140.0, 40.0));
        assert_ne!(surfaces.at(20.0, 40.0), surfaces.at(80.0, 40.0));
    }

    #[test]
    fn continuous_tilt_and_curvature_do_not_fragment_a_surface() {
        let mut g = Geometry::flat(240, 80);
        for y in 0..g.height {
            for x in 0..g.width {
                let t = x as f32 / g.width as f32;
                g.depth[y * g.width + x] = 1.0 + t + t * t;
            }
        }
        let surfaces = Surfaces::new(&g, 2);
        assert_eq!(surfaces.at(0.0, 40.0), surfaces.at(239.0, 40.0));
    }

    #[test]
    fn touching_planes_remain_separate_at_a_fold() {
        let mut g = Geometry::flat(240, 80);
        for y in 0..g.height {
            for x in 120..g.width {
                g.depth[y * g.width + x] = 2.0 / (1.0 + (x - 120) as f32 * 0.02);
            }
            for x in 0..120 {
                g.depth[y * g.width + x] = 2.0;
            }
        }
        let surfaces = Surfaces::new(&g, 2);
        assert_ne!(surfaces.at(30.0, 40.0), surfaces.at(210.0, 40.0));
    }
}

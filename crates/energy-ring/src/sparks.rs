//! CPU-simulated sparks thrown off the ring, drawn as additive point sprites.

use core::f32::consts::PI;

use crate::analysis::BANDS;

pub const CAPACITY: usize = 1024;
pub const FLOATS_PER_SPARK: usize = 4;

const DRAG_PER_SEC: f32 = 1.6;

pub struct Sparks {
    /// GPU vertex layout: x, y, remaining life (1 → 0), ring coordinate at birth.
    vertices: Vec<[f32; FLOATS_PER_SPARK]>,
    /// Parallel to `vertices`: velocity x, velocity y, 1 / lifetime in seconds.
    motion: Vec<[f32; 3]>,
    rng: u32,
}

impl Sparks {
    pub fn new() -> Self {
        Self {
            vertices: Vec::with_capacity(CAPACITY),
            motion: Vec::with_capacity(CAPACITY),
            rng: 0x9E37_79B9,
        }
    }

    /// Spawns up to `count` sparks on the ring, favouring loud bands. The
    /// angle convention matches `ring.frag`: 0 at the top, bass first.
    pub fn emit(&mut self, count: usize, radius: f32, flare: f32, bands: &[f32; BANDS]) {
        let count = count.min(CAPACITY - self.vertices.len());
        for _ in 0..count {
            let hue = self.random();
            let level = bands[((hue * BANDS as f32) as usize).min(BANDS - 1)];
            if level < 0.6 * self.random() {
                continue;
            }
            let side = if self.random() < 0.5 { -1.0 } else { 1.0 };
            let (sin, cos) = (side * hue * PI).sin_cos();
            let distance = radius + flare * level * self.random();
            let speed = (0.12 + 0.9 * level) * (0.5 + self.random());
            let swirl = 0.5 * (self.random() - 0.5);
            let lifetime = 0.45 + 0.9 * self.random();

            self.vertices
                .push([sin * distance, cos * distance, 1.0, hue]);
            self.motion.push([
                (sin + cos * swirl) * speed,
                (cos - sin * swirl) * speed,
                1.0 / lifetime,
            ]);
        }
    }

    pub fn step(&mut self, dt: f32) {
        let drag = (-DRAG_PER_SEC * dt).exp();
        let mut i = 0;
        while i < self.vertices.len() {
            let [vx, vy, life_rate] = self.motion[i];
            let vertex = &mut self.vertices[i];
            vertex[2] -= dt * life_rate;
            if vertex[2] <= 0.0 {
                self.vertices.swap_remove(i);
                self.motion.swap_remove(i);
                continue;
            }
            vertex[0] += vx * dt;
            vertex[1] += vy * dt;
            self.motion[i] = [vx * drag, vy * drag, life_rate];
            i += 1;
        }
    }

    /// Live sparks as a flat vertex buffer.
    pub fn vertices(&self) -> &[f32] {
        self.vertices.as_flattened()
    }

    /// Xorshift32, uniform in `0..1`.
    fn random(&mut self) -> f32 {
        self.rng ^= self.rng << 13;
        self.rng ^= self.rng >> 17;
        self.rng ^= self.rng << 5;
        (self.rng >> 8) as f32 / (1 << 24) as f32
    }
}

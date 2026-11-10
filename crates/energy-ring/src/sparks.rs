//! CPU-simulated sparks thrown off the ring's crest along its normal,
//! drawn as additive point sprites.

use core::f32::consts::PI;

use crate::analysis::{BANDS, level_at};
use crate::camera::Camera;
use crate::ring::Vertex;

pub const CAPACITY: usize = 1024;

const DRAG_PER_SEC: f32 = 1.6;

struct Spark {
    /// Ring space; see `camera`.
    position: [f32; 3],
    velocity: [f32; 3],
    /// Remaining life, 1 → 0.
    life: f32,
    /// 1 / lifetime in seconds.
    fade_rate: f32,
    /// Ring coordinate at birth; picks the colour.
    hue: f32,
}

pub struct Sparks {
    live: Vec<Spark>,
    rng: u32,
}

impl Sparks {
    pub fn new() -> Self {
        Self {
            live: Vec::with_capacity(CAPACITY),
            rng: 0x9E37_79B9,
        }
    }

    /// Spawns up to `count` sparks between the rest circle and the crest,
    /// favouring loud bands. Angles follow `ring::build`: the spectrum
    /// mirrors about angle 0, and `spin` rotates the ring about its axis.
    pub fn emit(
        &mut self,
        count: usize,
        radius: f32,
        spin: f32,
        height: f32,
        bands: &[f32; BANDS],
    ) {
        let count = count.min(CAPACITY - self.live.len());
        for _ in 0..count {
            let angle = PI * (2.0 * self.random() - 1.0);
            let hue = angle.abs() / PI;
            let level = level_at(bands, hue);
            if level < 0.6 * self.random() {
                continue;
            }
            let (sin, cos) = (angle + spin).sin_cos();
            let rise = (0.25 + 1.2 * level) * (0.5 + self.random());
            let outward = 0.1 + 0.3 * level * self.random();
            let swirl = 0.4 * (self.random() - 0.5);
            let start = height * level * self.random();
            let lifetime = 0.45 + 0.9 * self.random();

            self.live.push(Spark {
                position: [radius * sin, start, radius * cos],
                // Mostly along the ring's normal, drifting outward.
                velocity: [
                    sin * outward + cos * swirl,
                    rise,
                    cos * outward - sin * swirl,
                ],
                life: 1.0,
                fade_rate: 1.0 / lifetime,
                hue,
            });
        }
    }

    pub fn step(&mut self, dt: f32) {
        let drag = (-DRAG_PER_SEC * dt).exp();
        self.live.retain_mut(|spark| {
            spark.life -= dt * spark.fade_rate;
            for (position, velocity) in spark.position.iter_mut().zip(&mut spark.velocity) {
                *position += *velocity * dt;
                *velocity *= drag;
            }
            spark.life > 0.0
        });
    }

    /// Appends one point vertex per live spark.
    pub fn write(&self, camera: &Camera, out: &mut Vec<Vertex>) {
        for spark in &self.live {
            let at = camera.project(spark.position);
            out.push([at.x, at.y, spark.life, spark.hue, at.scale, 0.0]);
        }
    }

    /// Xorshift32, uniform in `0..1`.
    fn random(&mut self) -> f32 {
        self.rng ^= self.rng << 13;
        self.rng ^= self.rng >> 17;
        self.rng ^= self.rng << 5;
        (self.rng >> 8) as f32 / (1 << 24) as f32
    }
}

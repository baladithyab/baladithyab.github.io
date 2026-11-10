//! Builds the ring as screen-space triangle strips: a translucent curtain
//! from the rest circle up to the audio-displaced crest, and glowing
//! ribbons along both.
//!
//! The spectrum displaces the ring along its normal (out of its plane),
//! never radially.

use core::f32::consts::{PI, TAU};

use crate::analysis::{BANDS, level_at};
use crate::camera::{Camera, Projected};

/// Unit-space x, y, then four parameters read by the fragment shaders.
pub type Vertex = [f32; 6];

const SEGMENTS: usize = 256;
/// A closed strip repeats its first point pair at the end.
pub const STRIP_VERTICES: usize = 2 * (SEGMENTS + 1);
/// The curtain strip comes first, then one strip per ribbon.
pub const STRIPS: usize = 1 + RIBBONS.len();

/// Rise of a full-scale band above the ring's plane, in ring radii.
pub const HEIGHT: f32 = 0.75;

/// Stations averaged on each side by one blur pass. Two passes span about
/// four bands, turning band steps into a smooth swell.
const BLUR_REACH: usize = 4;

struct Ribbon {
    /// 0 follows the rest circle, 1 follows the displaced crest.
    lift: f32,
    /// Strength of the noisy wander that makes a filament look electric.
    wander: f32,
    /// Noise offset so filaments wander independently.
    seed: f32,
    /// Half-width in unit space at the ring centre's depth.
    half_width: f32,
    gain: f32,
    /// 0 draws a sharp line, 1 a broad haze.
    softness: f32,
}

const RIBBONS: [Ribbon; 5] = [
    // Rest circle: shows the plane the crest rises from.
    Ribbon {
        lift: 0.0,
        wander: 0.0,
        seed: 0.0,
        half_width: 0.03,
        gain: 0.3,
        softness: 0.0,
    },
    // Haze around the crest. Kept narrower than the tightest screen-space
    // bend of the ring, or the strip would fold over itself.
    Ribbon {
        lift: 1.0,
        wander: 0.0,
        seed: 0.0,
        half_width: 0.1,
        gain: 0.22,
        softness: 1.0,
    },
    // Crest core and two looser filaments.
    Ribbon {
        lift: 1.0,
        wander: 0.3,
        seed: 0.0,
        half_width: 0.06,
        gain: 1.0,
        softness: 0.0,
    },
    Ribbon {
        lift: 1.0,
        wander: 1.0,
        seed: 7.3,
        half_width: 0.045,
        gain: 0.55,
        softness: 0.0,
    },
    Ribbon {
        lift: 1.0,
        wander: 1.7,
        seed: 14.6,
        half_width: 0.045,
        gain: 0.4,
        softness: 0.0,
    },
];

/// Everything that shapes the ring on one frame.
pub struct Shape<'a> {
    /// Band levels from `Analysis::blurred`.
    pub bands: &'a [f32; BANDS],
    pub radius: f32,
    /// Rotation of the ring about its own axis, in radians.
    pub spin: f32,
    /// Animation clock in seconds.
    pub clock: f32,
    pub energy: f32,
    /// Brightness multiplier; above 1 on beats.
    pub flash: f32,
}

/// Per-segment values shared by the curtain and every ribbon.
#[derive(Clone, Copy)]
struct Station {
    /// Unit direction from the ring centre, in the ring's plane.
    sin: f32,
    cos: f32,
    /// Fixed coordinates for sampling filament noise around the loop.
    noise_x: f32,
    noise_y: f32,
    /// Ring coordinate: 0 at the bass point, 1 opposite it.
    hue: f32,
    level: f32,
}

/// Appends `STRIPS` strips of `STRIP_VERTICES` vertices each to `out`.
pub fn build(out: &mut Vec<Vertex>, camera: &Camera, shape: &Shape) {
    // -PI..PI around the loop; the spectrum mirrors about angle 0.
    let angle_of = |i: usize| TAU * i as f32 / SEGMENTS as f32 - PI;
    let levels = soften(soften(core::array::from_fn(|i| {
        level_at(shape.bands, angle_of(i).abs() / PI)
    })));
    let stations: [Station; SEGMENTS] = core::array::from_fn(|i| {
        let angle = angle_of(i);
        let (sin, cos) = (angle + shape.spin).sin_cos();
        let (noise_y, noise_x) = angle.sin_cos();
        Station {
            sin,
            cos,
            noise_x,
            noise_y,
            hue: angle.abs() / PI,
            level: levels[i],
        }
    });

    for i in 0..=SEGMENTS {
        let station = stations[i % SEGMENTS];
        let rest = camera.project(point(&station, shape.radius, 0.0));
        let crest = camera.project(point(&station, shape.radius, HEIGHT * station.level));
        let gain = shape.flash * depth_gain(crest.scale);
        out.push([rest.x, rest.y, 0.0, station.hue, station.level, gain]);
        out.push([crest.x, crest.y, 1.0, station.hue, station.level, gain]);
    }

    let mut path = [Projected {
        x: 0.0,
        y: 0.0,
        scale: 1.0,
    }; SEGMENTS];
    for ribbon in &RIBBONS {
        for (projected, station) in path.iter_mut().zip(&stations) {
            // Filaments wander mostly along the normal, a little radially.
            let reach = ribbon.wander * (0.02 + 0.1 * shape.energy + 0.12 * station.level);
            let drift = 0.6 * shape.clock + ribbon.seed;
            let rise = fbm(2.5 * station.noise_x + drift, 2.5 * station.noise_y) - 0.47;
            let spread = fbm(2.5 * station.noise_x, 2.5 * station.noise_y + drift + 31.7) - 0.47;
            *projected = camera.project(point(
                station,
                shape.radius + 0.5 * reach * spread,
                ribbon.lift * HEIGHT * station.level + reach * rise,
            ));
        }

        for i in 0..=SEGMENTS {
            let here = path[i % SEGMENTS];
            let before = path[(i + SEGMENTS - 1) % SEGMENTS];
            let after = path[(i + 1) % SEGMENTS];
            // Offsetting along the normal of the neighbours' chord gives
            // smooth joins without miter spikes at sharp peaks.
            let (along_x, along_y) = (after.x - before.x, after.y - before.y);
            let chord = (along_x * along_x + along_y * along_y).sqrt().max(1e-6);
            // A strip wider than the bend it follows folds over itself and,
            // blended additively, shows as a bright knot.
            let half_width =
                (ribbon.half_width * here.scale).min(0.9 * bend_radius(before, here, after));
            let (side_x, side_y) = (-along_y / chord * half_width, along_x / chord * half_width);

            let hue = stations[i % SEGMENTS].hue;
            let gain = ribbon.gain * shape.flash * depth_gain(here.scale);
            out.push([
                here.x + side_x,
                here.y + side_y,
                1.0,
                hue,
                gain,
                ribbon.softness,
            ]);
            out.push([
                here.x - side_x,
                here.y - side_y,
                -1.0,
                hue,
                gain,
                ribbon.softness,
            ]);
        }
    }
}

fn point(station: &Station, radius: f32, height: f32) -> [f32; 3] {
    [radius * station.sin, height, radius * station.cos]
}

/// Radius of the circle through three consecutive path points.
fn bend_radius(a: Projected, b: Projected, c: Projected) -> f32 {
    let (ab_x, ab_y) = (b.x - a.x, b.y - a.y);
    let (bc_x, bc_y) = (c.x - b.x, c.y - b.y);
    let (ac_x, ac_y) = (c.x - a.x, c.y - a.y);
    let sides =
        ((ab_x * ab_x + ab_y * ab_y) * (bc_x * bc_x + bc_y * bc_y) * (ac_x * ac_x + ac_y * ac_y))
            .sqrt();
    let twice_area = (ab_x * bc_y - ab_y * bc_x).abs();
    sides / (2.0 * twice_area).max(1e-9)
}

/// One box-blur pass around the closed loop.
fn soften(levels: [f32; SEGMENTS]) -> [f32; SEGMENTS] {
    core::array::from_fn(|i| {
        let window =
            (0..=2 * BLUR_REACH).map(|k| levels[(i + SEGMENTS + k - BLUR_REACH) % SEGMENTS]);
        window.sum::<f32>() / (2 * BLUR_REACH + 1) as f32
    })
}

/// Dims the far side of the ring and brightens the near side.
fn depth_gain(scale: f32) -> f32 {
    scale * scale.sqrt()
}

fn fbm(mut x: f32, mut y: f32) -> f32 {
    let mut sum = 0.0;
    let mut amplitude = 0.5;
    for _ in 0..3 {
        sum += amplitude * noise(x, y);
        x = 2.03 * x + 17.1;
        y = 2.03 * y + 17.1;
        amplitude *= 0.5;
    }
    sum
}

/// Value noise in `0..1`.
fn noise(x: f32, y: f32) -> f32 {
    let (cell_x, cell_y) = (x.floor(), y.floor());
    let (fx, fy) = (x - cell_x, y - cell_y);
    let (ux, uy) = (fx * fx * (3.0 - 2.0 * fx), fy * fy * (3.0 - 2.0 * fy));
    let (cx, cy) = (cell_x as i32, cell_y as i32);
    let bottom = lerp(hash(cx, cy), hash(cx + 1, cy), ux);
    let top = lerp(hash(cx, cy + 1), hash(cx + 1, cy + 1), ux);
    lerp(bottom, top, uy)
}

fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

/// Integer lattice hash, uniform in `0..1`.
fn hash(x: i32, y: i32) -> f32 {
    let mut h = (x as u32).wrapping_mul(0x27D4_EB2D) ^ (y as u32).wrapping_mul(0x1656_67B1);
    h ^= h >> 15;
    h = h.wrapping_mul(0x85EB_CA6B);
    h ^= h >> 13;
    (h >> 8) as f32 / (1 << 24) as f32
}

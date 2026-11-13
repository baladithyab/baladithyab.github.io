//! Smart mask: restricts a stroke to pixels that resemble the surface it
//! started on, by depth, surface normal and colour.
//!
//! This is the mechanism behind Deep Brush's "paint under the arm": the brush
//! footprint itself ignores occlusion, and the mask removes the occluder.
//! It is a port of the Labs preview's mask (see docs/DEEP_BRUSH.md):
//!
//! - At pointer-down a [`Reference`] is taken from a 7 × 7 patch: the value
//!   of the pixel under the pointer (the seed) and, per cue, a robust centre,
//!   spread and per-ring similarity mass of the patch.
//! - Per cue, a stroke accepts a capsule in feature space from the seed
//!   towards the patch centre ([`Range`]). Stronger settings shrink both the
//!   capsule's reach and its radius.
//! - Each pixel's distance to the capsule is measured in units of the cue's
//!   tolerance, the cues are combined with a 4-norm, and coverage falls from
//!   1 to 0 across `1 ± SOFTNESS` (stamp.wgsl).
//! - The reference stays fixed for the whole stroke unless
//!   [`SmartMask::follow`] is set (the preview's "dynamic" tolerance, off by
//!   default there too).
//!
//! There is no connectivity requirement, so a patch of wall enclosed by an
//! occluder (the gap between someone's legs) is painted like the rest of
//! the wall.

use crate::geometry::{self, Geometry, V3};

/// Half-width of the soft band around the tolerance boundary.
pub const SOFTNESS: f32 = 0.15;
/// Tolerances at the default strength (50) for a flat patch: log-depth,
/// normal angle (radians), and CIELAB distance with L, a, b divided by 100.
const BASE: [f32; 3] = [0.1487, std::f32::consts::FRAC_PI_4, 0.0764];
/// Largest tolerance per cue, however textured the reference patch: half
/// of log(100), a right angle, and half the colour range.
const CAP: [f32; 3] = [std::f32::consts::LN_10, std::f32::consts::FRAC_PI_2, 0.5];
const DEFAULT_STRENGTH: f32 = 50.0;
/// The preview uses 50 for every cue, with normals predicted by RGB↔X.
/// Normals derived from monocular depth bend near people and in small
/// enclosed patches of wall (45–60° on the sample photo), so 50 leaves
/// holes there; 40 (about 74°) fills them and still separates a wall from
/// the floor.
const DEFAULT_NORMAL_STRENGTH: f32 = 40.0;
/// Weight of lightness against chroma in the colour distance.
const LIGHTNESS_WEIGHT: f32 = 0.5;
/// How much the patch's own variation loosens a tolerance.
const TEXTURE_ADAPTIVITY: f32 = 1.5;
/// Patch pixels further than this many base tolerances from the seed count
/// little towards the reference.
const SIMILARITY_WIDTH: f32 = 2.0;
/// Distance (px) over which patch pixels lose weight.
const NEIGHBOURHOOD_FALLOFF: f32 = 2.0;
/// Patch radius in pixels (7 × 7).
const PATCH: isize = 3;
/// Neighbourhood radius at strength 0: the patch's corner ring plus one.
const PATCH_REACH: f32 = 3.0 * std::f32::consts::SQRT_2 + 1.0;
/// Squared radii of the rings of a 7 × 7 patch.
const RINGS: [isize; 10] = [0, 1, 2, 4, 5, 8, 9, 10, 13, 18];
/// With [`SmartMask::follow`], the reference moves a fraction
/// 1 − e^(−d / (FOLLOW_LENGTH · diameter)) of the way to each new sample,
/// d being the distance moved.
const FOLLOW_LENGTH: f32 = 0.3;

/// Cue strengths in 0..=100; 0 turns a cue off, higher is stricter.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SmartMask {
    pub enabled: bool,
    pub depth: f32,
    pub normal: f32,
    pub color: f32,
    /// Re-sample the reference as the stroke moves.
    pub follow: bool,
}

impl Default for SmartMask {
    fn default() -> Self {
        Self {
            enabled: true,
            depth: DEFAULT_STRENGTH,
            normal: DEFAULT_NORMAL_STRENGTH,
            color: 0.0,
            follow: false,
        }
    }
}

/// Log-depth, unit normal, and CIELAB colour (each component divided by 100).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Features {
    pub log_depth: f32,
    pub normal: V3,
    pub lab: [f32; 3],
}

/// What the surface under a dab looks like.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Reference {
    /// The pixel under the dab.
    pub seed: Features,
    /// Robust centre of the patch.
    centre: Features,
    /// Typical distance of the patch's pixels from the centre, per cue.
    spread: [f32; 3],
    /// Per cue, how similar each ring of the patch is to the seed.
    mass: [[f32; RINGS.len()]; 3],
}

/// What a stroke accepts: per cue, the segment from `start` to `end`
/// widened by `tolerance` (0 = cue off).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Range {
    pub start: Features,
    pub end: Features,
    pub tolerance: [f32; 3],
}

impl SmartMask {
    pub fn range(&self, reference: &Reference) -> Range {
        let strengths = [self.depth, self.normal, self.color];
        let mut reach = [0f32; 3];
        let tolerance = std::array::from_fn(|cue| {
            let s = strengths[cue].clamp(0.0, 100.0);
            if !self.enabled || s <= 0.0 {
                return 0.0;
            }
            let s = effective(cue, s);
            reach[cue] = patch_reach(&reference.mass[cue], s);
            base_tolerance(cue, reference.spread[cue]) * qn(s / 100.0)
                / qn(effective(cue, DEFAULT_STRENGTH) / 100.0)
        });
        let (seed, centre) = (reference.seed, reference.centre);
        let end = Features {
            log_depth: seed.log_depth + reach[0] * (centre.log_depth - seed.log_depth),
            normal: geometry::normalize(geometry::add(
                geometry::scale(seed.normal, 1.0 - reach[1]),
                geometry::scale(centre.normal, reach[1]),
            )),
            lab: std::array::from_fn(|c| seed.lab[c] + reach[2] * (centre.lab[c] - seed.lab[c])),
        };
        Range {
            start: seed,
            end,
            tolerance,
        }
    }
}

/// Strength rescaled per cue, as in the preview, before the exponential
/// easing in [`qn`].
fn effective(cue: usize, s: f32) -> f32 {
    match cue {
        0 => 29.0 + 0.7 * s,
        1 => s * (1.35 - 0.005 * s),
        _ => s,
    }
}

/// Falls from 1 at 0 to 0 at 1.
fn qn(t: f32) -> f32 {
    let floor = (-5f32).exp();
    ((-5.0 * t).exp() - floor) / (1.0 - floor)
}

fn base_tolerance(cue: usize, spread: f32) -> f32 {
    BASE[cue].hypot(TEXTURE_ADAPTIVITY * spread).min(CAP[cue])
}

/// Weight of a patch ring at `distance` px; the neighbourhood shrinks as the
/// (effective) strength grows.
fn neighbourhood(distance: f32, strength: f32) -> f32 {
    let radius = PATCH_REACH * (1.0 - strength.clamp(0.0, 100.0) / 100.0);
    if distance < radius {
        (-distance / NEIGHBOURHOOD_FALLOFF).exp() * (1.0 - distance / radius)
    } else {
        0.0
    }
}

/// How far the accepted range extends from the seed towards the patch
/// centre: the share of the patch's similar pixels inside the neighbourhood.
fn patch_reach(mass: &[f32; RINGS.len()], strength: f32) -> f32 {
    let within = |s: f32| -> f32 {
        RINGS
            .iter()
            .zip(mass)
            .map(|(&r, &m)| neighbourhood((r as f32).sqrt(), s) * m)
            .sum()
    };
    let full = within(0.0);
    if full > 0.0 {
        (within(strength) / full).min(1.0)
    } else {
        0.0
    }
}

impl Reference {
    pub fn sample(geometry: &Geometry, rgba: &[u8], normal_step: f32, x: f32, y: f32) -> Self {
        let cx = (x.floor() as isize).clamp(0, geometry.width as isize - 1);
        let cy = (y.floor() as isize).clamp(0, geometry.height as isize - 1);
        let mut pixels: Vec<(usize, Features)> = Vec::with_capacity(49);
        for oy in -PATCH..=PATCH {
            for ox in -PATCH..=PATCH {
                let (px, py) = (cx + ox, cy + oy);
                if px < 0
                    || py < 0
                    || px >= geometry.width as isize
                    || py >= geometry.height as isize
                {
                    continue;
                }
                let ring = RINGS
                    .iter()
                    .position(|&r| r == ox * ox + oy * oy)
                    .expect("every patch offset lies on a ring");
                let (fx, fy) = (px as f32 + 0.5, py as f32 + 0.5);
                pixels.push((
                    ring,
                    Features {
                        log_depth: geometry.depth_at(fx, fy).ln(),
                        normal: geometry.normal(fx, fy, normal_step),
                        lab: lab(rgba, py as usize * geometry.width + px as usize),
                    },
                ));
            }
        }
        let seed = pixels
            .iter()
            .find(|p| p.0 == 0)
            .expect("the seed pixel is inside the image")
            .1;

        let mut centre = seed;
        let mut spread = [0f32; 3];
        let mut mass = [[0f32; RINGS.len()]; 3];
        for cue in 0..3 {
            let width = SIMILARITY_WIDTH * BASE[cue];
            let weights: Vec<f32> = pixels
                .iter()
                .map(|(ring, f)| {
                    let similarity = (-0.5 * (distance(cue, f, &seed) / width).powi(2)).exp();
                    mass[cue][*ring] += similarity;
                    (neighbourhood((RINGS[*ring] as f32).sqrt(), 0.0) * similarity).max(1e-12)
                })
                .collect();
            set_centre(cue, &mut centre, &pixels, &weights);
            let distances: Vec<(f32, f32)> = pixels
                .iter()
                .zip(&weights)
                .map(|((_, f), &w)| (distance(cue, f, &centre), w))
                .collect();
            spread[cue] = weighted_median(&distances);
        }
        Self {
            seed,
            centre,
            spread,
            mass,
        }
    }

    /// With [`SmartMask::follow`]: moves the seed towards `sample` after the
    /// stroke has travelled `moved` px with a brush `diameter` px wide, and
    /// takes the sample's patch statistics. A cue whose sample is outside
    /// its base tolerance jumps to the sample outright.
    pub fn follow(&mut self, sample: &Reference, moved: f32, diameter: f32) {
        let t = 1.0 - (-moved.max(0.0) / (FOLLOW_LENGTH * diameter.max(1e-3))).exp();
        for cue in 0..3 {
            let limit = base_tolerance(cue, self.spread[cue]);
            let mut seed = sample.seed;
            if distance(cue, &sample.seed, &self.seed) <= limit {
                seed = self.seed;
                match cue {
                    0 => seed.log_depth += t * (sample.seed.log_depth - seed.log_depth),
                    1 => {
                        seed.normal = geometry::normalize(geometry::add(
                            geometry::scale(seed.normal, 1.0 - t),
                            geometry::scale(sample.seed.normal, t),
                        ))
                    }
                    _ => (0..3).for_each(|c| seed.lab[c] += t * (sample.seed.lab[c] - seed.lab[c])),
                }
            }
            copy_cue(cue, &mut self.seed, &seed);
            copy_cue(cue, &mut self.centre, &sample.centre);
            self.spread[cue] = sample.spread[cue];
            self.mass[cue] = sample.mass[cue];
        }
    }
}

fn distance(cue: usize, a: &Features, b: &Features) -> f32 {
    match cue {
        0 => (a.log_depth - b.log_depth).abs(),
        1 => geometry::dot(a.normal, b.normal).clamp(-1.0, 1.0).acos(),
        _ => {
            let dl = LIGHTNESS_WEIGHT * (a.lab[0] - b.lab[0]);
            (dl * dl + (a.lab[1] - b.lab[1]).powi(2) + (a.lab[2] - b.lab[2]).powi(2)).sqrt()
        }
    }
}

fn copy_cue(cue: usize, to: &mut Features, from: &Features) {
    match cue {
        0 => to.log_depth = from.log_depth,
        1 => to.normal = from.normal,
        _ => to.lab = from.lab,
    }
}

/// Weighted median for depth; weighted geometric median (Weiszfeld) for
/// normals and colour.
fn set_centre(cue: usize, centre: &mut Features, pixels: &[(usize, Features)], weights: &[f32]) {
    if cue == 0 {
        let samples: Vec<(f32, f32)> = pixels
            .iter()
            .zip(weights)
            .map(|((_, f), &w)| (f.log_depth, w))
            .collect();
        centre.log_depth = weighted_median(&samples);
        return;
    }
    let point = |f: &Features| if cue == 1 { f.normal } else { f.lab };
    // Colour distances weight lightness as `distance` does.
    let scale = if cue == 1 {
        [1.0, 1.0, 1.0]
    } else {
        [LIGHTNESS_WEIGHT, 1.0, 1.0]
    };
    let total: f32 = weights.iter().sum();
    let mut m = [0f32; 3];
    for ((_, f), &w) in pixels.iter().zip(weights) {
        (0..3).for_each(|c| m[c] += w * point(f)[c] / total);
    }
    for _ in 0..16 {
        let mut next = [0f32; 3];
        let mut sum = 0.0;
        for ((_, f), &w) in pixels.iter().zip(weights) {
            let p = point(f);
            let d = (0..3)
                .map(|c| ((p[c] - m[c]) * scale[c]).powi(2))
                .sum::<f32>()
                .sqrt();
            let k = w / d.max(1e-9);
            (0..3).for_each(|c| next[c] += k * p[c]);
            sum += k;
        }
        if sum <= 0.0 {
            break;
        }
        let next = next.map(|v| v / sum);
        let moved: f32 = (0..3).map(|c| (next[c] - m[c]).abs()).sum();
        m = next;
        if moved < 1e-7 {
            break;
        }
    }
    if cue == 1 {
        centre.normal = geometry::normalize(m);
    } else {
        centre.lab = m;
    }
}

/// CIELAB (D65) of the sRGB pixel at `index`, each component divided by 100.
/// Mirrors `lab` in stamp.wgsl.
fn lab(rgba: &[u8], index: usize) -> [f32; 3] {
    let linear = |c: u8| {
        let c = c as f32 / 255.0;
        if c <= 0.04045 {
            c / 12.92
        } else {
            ((c + 0.055) / 1.055).powf(2.4)
        }
    };
    let [r, g, b] = [0, 1, 2].map(|c| linear(rgba[index * 4 + c]));
    let x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
    let y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    let z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
    let f = |t: f32| {
        if t > 0.008856 {
            t.cbrt()
        } else {
            7.787 * t + 16.0 / 116.0
        }
    };
    let (fx, fy, fz) = (f(x), f(y), f(z));
    [
        (116.0 * fy - 16.0) / 100.0,
        5.0 * (fx - fy),
        2.0 * (fy - fz),
    ]
}

fn weighted_median(samples: &[(f32, f32)]) -> f32 {
    let mut sorted = samples.to_vec();
    sorted.sort_by(|a, b| a.0.total_cmp(&b.0));
    let half = 0.5 * sorted.iter().map(|s| s.1).sum::<f32>();
    let mut running = 0.0;
    for (value, weight) in &sorted {
        running += weight;
        if running >= half {
            return *value;
        }
    }
    sorted.last().map_or(0.0, |s| s.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wall_with_occluder(occluder_columns: std::ops::Range<usize>) -> (Geometry, Vec<u8>) {
        let mut g = Geometry::flat(32, 32);
        for y in 0..32 {
            for x in occluder_columns.clone() {
                g.depth[y * 32 + x] = 1.0;
            }
        }
        (g, vec![128u8; 32 * 32 * 4])
    }

    #[test]
    fn strength_eases_tolerance_and_zero_disables() {
        let reference = Reference::sample(
            &Geometry::flat(16, 16),
            &vec![128; 16 * 16 * 4],
            2.0,
            8.0,
            8.0,
        );
        let at = |depth: f32| {
            SmartMask {
                depth,
                ..SmartMask::default()
            }
            .range(&reference)
            .tolerance[0]
        };
        assert!(
            (at(50.0) - BASE[0]).abs() < 1e-6,
            "default strength gives the base tolerance"
        );
        assert!(at(75.0) < 0.5 * BASE[0] && at(25.0) > 2.0 * BASE[0]);
        assert!(
            at(100.0) < 0.02 * BASE[0],
            "full strength accepts almost nothing"
        );
        assert_eq!(at(0.0), 0.0);
        let off = SmartMask {
            enabled: false,
            ..SmartMask::default()
        };
        assert_eq!(off.range(&reference).tolerance, [0.0; 3]);
    }

    #[test]
    fn range_reaches_from_the_seed_towards_the_patch_but_not_onto_an_occluder() {
        // Seed on the wall; three of the seven patch columns are a much
        // closer occluder.
        let (g, rgba) = wall_with_occluder(17..20);
        let reference = Reference::sample(&g, &rgba, 2.0, 16.5, 16.5);
        let wall = g.depth[16 * 32 + 10].ln();
        let range = SmartMask::default().range(&reference);
        assert!((range.start.log_depth - wall).abs() < 1e-4);
        assert!((range.end.log_depth - wall).abs() < 1e-4);
    }

    #[test]
    fn follow_eases_small_changes_and_jumps_to_large_ones() {
        let (g, rgba) = wall_with_occluder(28..32);
        let mut reference = Reference::sample(&g, &rgba, 2.0, 8.5, 16.5);
        let start = reference.seed.log_depth;

        let mut nearby = reference;
        nearby.seed.log_depth += 0.5 * BASE[0];
        reference.follow(&nearby, 3.0, 20.0);
        let eased = reference.seed.log_depth;
        assert!(eased > start && eased < nearby.seed.log_depth);

        let occluder = Reference::sample(&g, &rgba, 2.0, 30.5, 16.5);
        reference.follow(&occluder, 3.0, 20.0);
        assert_eq!(reference.seed.log_depth, occluder.seed.log_depth);
    }
}

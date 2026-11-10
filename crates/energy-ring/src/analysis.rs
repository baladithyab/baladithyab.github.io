//! Turns `AnalyserNode` byte spectra into smoothed bands and a beat pulse.

use core::ops::Range;

/// Log-spaced bands from bass to treble, about seven per octave.
pub const BANDS: usize = 64;

// Band ranges at 44.1/48 kHz with the edges from `set_bins`.
const BASS: Range<usize> = 0..16; // ~30–150 Hz
const MID: Range<usize> = 16..44; // ~150 Hz–2.3 kHz
const TREBLE: Range<usize> = 44..BANDS; // ~2.3–16 kHz

/// Byte level treated as silence. Analyser bytes are dB-linear, so quiet
/// passages still sit well above zero.
const FLOOR: f32 = 0.25;
/// Gain added linearly toward the top band; music carries less energy there.
const TILT: f32 = 1.5;

const ATTACK_SECS: f32 = 0.015;
const RELEASE_SECS: f32 = 0.22;

/// How far raw bass must jump above its running average to count as a beat.
const ONSET_MARGIN: f32 = 0.1;
const ONSET_COOLDOWN_SECS: f32 = 0.18;
const BASS_AVERAGE_SECS: f32 = 0.35;
const BEAT_DECAY_PER_SEC: f32 = 5.0;

pub struct Analysis {
    /// Band levels in `0..=1`, smoothed over time.
    bands: [f32; BANDS],
    pub bass: f32,
    pub mid: f32,
    pub treble: f32,
    /// Jumps to 1 on a bass onset, then decays toward 0.
    pub beat: f32,
    /// True only for the update that detected an onset.
    pub onset: bool,
    /// First FFT bin of each band, plus the end of the last band.
    edges: [usize; BANDS + 1],
    bass_average: f32,
    cooldown: f32,
}

impl Analysis {
    pub fn new() -> Self {
        Self {
            bands: [0.0; BANDS],
            bass: 0.0,
            mid: 0.0,
            treble: 0.0,
            beat: 0.0,
            onset: false,
            edges: [0; BANDS + 1],
            bass_average: 0.0,
            cooldown: 0.0,
        }
    }

    /// Maps bands onto an FFT with `bins` frequency bins.
    pub fn set_bins(&mut self, bins: usize) {
        // Skip DC; stop near 16 kHz, above which most material is empty.
        let low = 1.5_f32;
        let high = bins as f32 * 0.72;
        for (k, edge) in self.edges.iter_mut().enumerate() {
            *edge = (low * (high / low).powf(k as f32 / BANDS as f32)) as usize;
        }
    }

    /// Advances the analysis by `dt` seconds. An empty `freq` reads as silence.
    pub fn update(&mut self, freq: &[u8], dt: f32) {
        let attack = smoothing(dt, ATTACK_SECS);
        let release = smoothing(dt, RELEASE_SECS);

        let mut raw_bass = 0.0;
        for (k, band) in self.bands.iter_mut().enumerate() {
            let start = self.edges[k];
            // Low bands are narrower than one bin; neighbours share it.
            let end = self.edges[k + 1].max(start + 1);
            let peak = freq
                .get(start..end)
                .and_then(|bins| bins.iter().max())
                .map_or(0.0, |&byte| f32::from(byte) / 255.0);

            let tilt = 1.0 + TILT * k as f32 / BANDS as f32;
            let level = ((peak - FLOOR) / (1.0 - FLOOR) * tilt).clamp(0.0, 1.0);
            // Squaring widens the gap between loud and quiet bands.
            let level = level * level;
            if BASS.contains(&k) {
                raw_bass += level;
            }
            *band += (level - *band) * if level > *band { attack } else { release };
        }
        raw_bass /= BASS.len() as f32;

        self.cooldown -= dt;
        self.onset = self.cooldown <= 0.0 && raw_bass - self.bass_average > ONSET_MARGIN;
        if self.onset {
            self.beat = 1.0;
            self.cooldown = ONSET_COOLDOWN_SECS;
        } else {
            self.beat *= (-BEAT_DECAY_PER_SEC * dt).exp();
        }
        self.bass_average += (raw_bass - self.bass_average) * smoothing(dt, BASS_AVERAGE_SECS);

        self.bass = mean(&self.bands[BASS]);
        self.mid = mean(&self.bands[MID]);
        self.treble = mean(&self.bands[TREBLE]);
    }

    /// Band levels blurred across neighbours, so one loud band does not
    /// stand out as an isolated spike.
    pub fn blurred(&self) -> [f32; BANDS] {
        core::array::from_fn(|k| {
            let below = self.bands[k.saturating_sub(1)];
            let above = self.bands[(k + 1).min(BANDS - 1)];
            0.25 * below + 0.5 * self.bands[k] + 0.25 * above
        })
    }
}

/// Level at ring coordinate `u` (0 is the lowest band, 1 the highest),
/// eased between neighbouring bands.
pub fn level_at(bands: &[f32; BANDS], u: f32) -> f32 {
    let position = u.clamp(0.0, 1.0) * (BANDS - 1) as f32;
    let below = (position as usize).min(BANDS - 2);
    let t = position - below as f32;
    let eased = t * t * (3.0 - 2.0 * t);
    bands[below] + (bands[below + 1] - bands[below]) * eased
}

/// Fraction of the remaining distance a one-pole filter covers in `dt`.
fn smoothing(dt: f32, time_constant: f32) -> f32 {
    1.0 - (-dt / time_constant).exp()
}

fn mean(values: &[f32]) -> f32 {
    values.iter().sum::<f32>() / values.len() as f32
}

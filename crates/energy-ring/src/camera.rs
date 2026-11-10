//! Fixed perspective camera looking down at the ring's plane.
//!
//! Ring space: the ring lies in the XZ plane, +Y is its normal, +Z points
//! at the viewer. Unit space: the shorter canvas side spans -1..1.

/// Camera distance from the ring centre, in ring radii.
const DISTANCE: f32 = 3.4;
/// Angle between the view direction and the ring's plane (about 24°).
const ELEVATION: f32 = 0.42;
/// Roll about the view axis (about -12°); this is what slopes the ring.
const ROLL: f32 = -0.21;
/// Unit-space size of one ring radius at the ring centre's depth.
const ZOOM: f32 = 0.7;
/// Downward shift that keeps the ring and its rising crest centred.
const DROP: f32 = 0.12;

pub struct Camera {
    sin_elevation: f32,
    cos_elevation: f32,
    sin_roll: f32,
    cos_roll: f32,
}

#[derive(Clone, Copy)]
pub struct Projected {
    pub x: f32,
    pub y: f32,
    /// Perspective scale: 1 at the ring centre's depth, larger when nearer.
    pub scale: f32,
}

impl Camera {
    pub fn new() -> Self {
        let (sin_elevation, cos_elevation) = ELEVATION.sin_cos();
        let (sin_roll, cos_roll) = ROLL.sin_cos();
        Self {
            sin_elevation,
            cos_elevation,
            sin_roll,
            cos_roll,
        }
    }

    /// Projects a ring-space point to unit space.
    pub fn project(&self, [x, y, z]: [f32; 3]) -> Projected {
        let up = y * self.cos_elevation - z * self.sin_elevation;
        let toward = y * self.sin_elevation + z * self.cos_elevation;
        // Nothing in the scene comes close to the camera; the floor only
        // guards the division.
        let scale = DISTANCE / (DISTANCE - toward).max(0.5);
        Projected {
            x: (x * self.cos_roll - up * self.sin_roll) * ZOOM * scale,
            y: (x * self.sin_roll + up * self.cos_roll) * ZOOM * scale - DROP,
            scale,
        }
    }
}

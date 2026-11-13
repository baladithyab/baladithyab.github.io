//! Geometry- and lighting-aware painting on photos.
//!
//! A port of Depth Anything V2 Small to WGSL estimates relative depth from a
//! single image. The brush engine derives surface positions and normals from
//! it, projects each dab onto the surface under the cursor, and keeps strokes
//! off occluders with a smart mask (depth, normal and colour similarity to the
//! surface the stroke started on).

pub mod depth;
pub mod editor;
pub mod geometry;
pub mod gpu;
pub mod mask;
pub mod preprocess;
pub mod safetensors;
#[cfg(target_arch = "wasm32")]
mod web;

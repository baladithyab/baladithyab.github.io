//! Geometry- and lighting-aware painting on photos.
//!
//! A port of Depth Anything V2 Small to WGSL estimates relative depth from a
//! single image; the brush engine derives surface positions and normals from
//! it to paint on surfaces rather than on the image plane.

pub mod depth;
pub mod editor;
pub mod geometry;
pub mod gpu;
pub mod preprocess;
pub mod safetensors;
mod surface;
#[cfg(target_arch = "wasm32")]
mod web;

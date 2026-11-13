//! CPU-side input preparation for Depth Anything V2, following
//! `DPTImageProcessor` (keep aspect ratio, multiple of 14, PIL bicubic,
//! ImageNet normalization) and DINOv2's bicubic position-embedding resize.

pub const PATCH: usize = 14;
const TARGET: f64 = 518.0;
/// Longest model side. Tokens grow with the area, and the head's largest
/// activation is 32 × (14·patches) floats; 72 patches keeps it under 70 MB.
pub const MAX_SIDE: usize = 1008;
const MEAN: [f32; 3] = [0.485, 0.456, 0.406];
const STD: [f32; 3] = [0.229, 0.224, 0.225];

/// Model input size (height, width) for an image, both multiples of 14.
pub fn model_size(width: usize, height: usize) -> (usize, usize) {
    let mut scale_h = TARGET / height as f64;
    let mut scale_w = TARGET / width as f64;
    // The processor keeps the scale closest to 1, so the shorter side lands
    // on 518 for photos larger than the model input.
    if (1.0 - scale_w).abs() < (1.0 - scale_h).abs() {
        scale_h = scale_w;
    } else {
        scale_w = scale_h;
    }
    let multiple = |v: f64| (((v / PATCH as f64).round() as usize).max(1)) * PATCH;
    let (mut h, mut w) = (
        multiple(scale_h * height as f64),
        multiple(scale_w * width as f64),
    );
    let long = h.max(w);
    if long > MAX_SIDE {
        let shrink = MAX_SIDE as f64 / long as f64;
        h = ((h as f64 * shrink / PATCH as f64).floor() as usize).max(1) * PATCH;
        w = ((w as f64 * shrink / PATCH as f64).floor() as usize).max(1) * PATCH;
    }
    (h, w)
}

/// RGBA8 pixels to a normalized CHW tensor of the given size.
pub fn image_tensor(
    rgba: &[u8],
    width: usize,
    height: usize,
    out_h: usize,
    out_w: usize,
) -> Vec<f32> {
    let mut rgb = vec![0f32; width * height * 3];
    for (i, px) in rgba.chunks_exact(4).enumerate() {
        rgb[i * 3] = px[0] as f32;
        rgb[i * 3 + 1] = px[1] as f32;
        rgb[i * 3 + 2] = px[2] as f32;
    }
    let resized = resize_bicubic(&rgb, width, height, out_w, out_h, 3);
    let plane = out_w * out_h;
    let mut tensor = vec![0f32; plane * 3];
    for i in 0..plane {
        for c in 0..3 {
            let v = resized[i * 3 + c].round().clamp(0.0, 255.0) / 255.0;
            tensor[c * plane + i] = (v - MEAN[c]) / STD[c];
        }
    }
    tensor
}

fn pil_bicubic(x: f64) -> f64 {
    const A: f64 = -0.5;
    let x = x.abs();
    if x < 1.0 {
        ((A + 2.0) * x - (A + 3.0)) * x * x + 1.0
    } else if x < 2.0 {
        (((x - 5.0) * x + 8.0) * x - 4.0) * A
    } else {
        0.0
    }
}

/// Antialiased resampling weights in the manner of PIL's `ImagingResample`.
fn pil_weights(input: usize, output: usize) -> Vec<(usize, Vec<f32>)> {
    let scale = input as f64 / output as f64;
    let filter_scale = scale.max(1.0);
    let support = 2.0 * filter_scale;
    (0..output)
        .map(|x| {
            let center = (x as f64 + 0.5) * scale;
            let lo = ((center - support + 0.5) as i64).max(0) as usize;
            let hi = ((center + support + 0.5) as i64).min(input as i64) as usize;
            let raw: Vec<f64> = (lo..hi)
                .map(|i| pil_bicubic((i as f64 - center + 0.5) / filter_scale))
                .collect();
            let sum: f64 = raw.iter().sum();
            let norm = if sum == 0.0 { 1.0 } else { sum };
            (lo, raw.iter().map(|w| (w / norm) as f32).collect())
        })
        .collect()
}

/// Separable resize of interleaved `channels`-wide pixels.
fn resize_bicubic(
    src: &[f32],
    width: usize,
    height: usize,
    out_w: usize,
    out_h: usize,
    channels: usize,
) -> Vec<f32> {
    let wx = pil_weights(width, out_w);
    let mut horizontal = vec![0f32; out_w * height * channels];
    for y in 0..height {
        for (x, (lo, weights)) in wx.iter().enumerate() {
            for c in 0..channels {
                let mut acc = 0f32;
                for (k, w) in weights.iter().enumerate() {
                    acc += w * src[(y * width + lo + k) * channels + c];
                }
                horizontal[(y * out_w + x) * channels + c] = acc;
            }
        }
    }
    let wy = pil_weights(height, out_h);
    let mut out = vec![0f32; out_w * out_h * channels];
    for (y, (lo, weights)) in wy.iter().enumerate() {
        for x in 0..out_w {
            for c in 0..channels {
                let mut acc = 0f32;
                for (k, w) in weights.iter().enumerate() {
                    acc += w * horizontal[((lo + k) * out_w + x) * channels + c];
                }
                out[(y * out_w + x) * channels + c] = acc;
            }
        }
    }
    out
}

/// PyTorch `interpolate(mode="bicubic", align_corners=False)` taps.
fn torch_cubic_taps(input: usize, output: usize) -> Vec<([usize; 4], [f32; 4])> {
    const A: f64 = -0.75;
    let near = |x: f64| ((A + 2.0) * x - (A + 3.0)) * x * x + 1.0;
    let far = |x: f64| ((A * x - 5.0 * A) * x + 8.0 * A) * x - 4.0 * A;
    let scale = input as f64 / output as f64;
    (0..output)
        .map(|o| {
            let real = (o as f64 + 0.5) * scale - 0.5;
            let base = real.floor();
            let t = real - base;
            let index = |d: i64| (base as i64 + d).clamp(0, input as i64 - 1) as usize;
            (
                [index(-1), index(0), index(1), index(2)],
                [
                    far(t + 1.0) as f32,
                    near(t) as f32,
                    near(1.0 - t) as f32,
                    far(2.0 - t) as f32,
                ],
            )
        })
        .collect()
}

/// Resizes DINOv2's position embeddings (`[1 + n·n, dim]`, class token
/// first) to a `rows × cols` patch grid.
pub fn position_embeddings(pos: &[f32], dim: usize, rows: usize, cols: usize) -> Vec<f32> {
    let n = ((pos.len() / dim - 1) as f64).sqrt() as usize;
    let mut out = vec![0f32; (1 + rows * cols) * dim];
    out[..dim].copy_from_slice(&pos[..dim]);
    let grid = &pos[dim..];
    if rows == n && cols == n {
        out[dim..].copy_from_slice(grid);
        return out;
    }
    let ty = torch_cubic_taps(n, rows);
    let tx = torch_cubic_taps(n, cols);
    for (r, (iy, wy)) in ty.iter().enumerate() {
        for (c, (ix, wx)) in tx.iter().enumerate() {
            let dst = &mut out[dim * (1 + r * cols + c)..][..dim];
            for i in 0..4 {
                for j in 0..4 {
                    let w = wy[i] * wx[j];
                    let src = &grid[dim * (iy[i] * n + ix[j])..][..dim];
                    for (d, s) in dst.iter_mut().zip(src) {
                        *d += w * s;
                    }
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_size_follows_dpt_processor() {
        // Shorter side to 518; longer side rounded to a multiple of 14.
        assert_eq!(model_size(1536, 1024), (518, 784));
        assert_eq!(model_size(1024, 1536), (784, 518));
        // Small images keep the scale closest to 1 (here the upscale of the longer side).
        assert_eq!(model_size(400, 300), (392, 518));
        // Very wide images are capped at MAX_SIDE patches.
        let (h, w) = model_size(4000, 1000);
        assert!(w <= MAX_SIDE && w % PATCH == 0 && h % PATCH == 0);
    }
}

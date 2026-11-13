#![cfg(not(target_arch = "wasm32"))]

//! Strokes across a figure standing in front of a wall, through the real
//! render path. The figure is a torso on two legs; the wall shows through
//! between the legs. Its disparity is given at half resolution with soft
//! edges, as a monocular depth model produces it, while the image edge is
//! sharp.

use deep_brush::{
    editor::{Editor, Mode},
    gpu::Gpu,
};

const W: usize = 400;
const H: usize = 160;
const ROW: usize = 110;
const WALL: u8 = 180;
const FIGURE: u8 = 90;

fn figure(x: usize, y: usize) -> bool {
    let torso = (20..70).contains(&y) && (120..280).contains(&x);
    let legs = (70..150).contains(&y) && ((120..160).contains(&x) || (240..280).contains(&x));
    torso || legs
}

fn scene() -> (Vec<u8>, Vec<f32>, usize, usize) {
    let mut rgba = vec![0u8; W * H * 4];
    for y in 0..H {
        for x in 0..W {
            let v = if figure(x, y) { FIGURE } else { WALL };
            rgba[(y * W + x) * 4..][..4].copy_from_slice(&[v, v, v, 255]);
        }
    }
    let (lw, lh) = (W / 2, H / 2);
    let hard: Vec<f32> = (0..lw * lh)
        .map(|i| {
            if figure((i % lw) * 2 + 1, (i / lw) * 2 + 1) {
                1.0
            } else {
                0.0
            }
        })
        .collect();
    // 5 × 5 box blur: a few texels of soft edge on each side.
    let mut soft = vec![0f32; lw * lh];
    for y in 0..lh as isize {
        for x in 0..lw as isize {
            let mut sum = 0.0;
            for oy in -2..=2 {
                for ox in -2..=2 {
                    let sx = (x + ox).clamp(0, lw as isize - 1) as usize;
                    let sy = (y + oy).clamp(0, lh as isize - 1) as usize;
                    sum += hard[sy * lw + sx];
                }
            }
            soft[y as usize * lw + x as usize] = sum / 25.0;
        }
    }
    (rgba, soft, lw, lh)
}

async fn paint(gpu: &Gpu, mode: Mode, masked: bool, dense: bool) -> Vec<u8> {
    let (rgba, disparity, lw, lh) = scene();
    let mut editor = Editor::new(gpu);
    editor.load_image(gpu, &rgba, W, H);
    editor.set_depth(gpu, &disparity, lw, lh);
    editor.mask.enabled = masked;
    editor.brush.mode = mode;
    editor.brush.radius = 6.0;
    editor.brush.hardness = 1.0;
    editor.brush.opacity = 1.0;
    editor.brush.color = [1.0, 0.0, 0.0];
    let (start, end) = (20.0, 380.0);
    editor.begin_stroke(gpu, start, ROW as f32 + 0.5);
    if dense {
        for x in start as usize + 1..=end as usize {
            editor.extend_stroke(gpu, x as f32, ROW as f32 + 0.5);
        }
    } else {
        editor.extend_stroke(gpu, end, ROW as f32 + 0.5);
    }
    editor.end_stroke(gpu);
    editor.render(gpu);
    editor.export(gpu).unwrap().read(gpu).await.unwrap()
}

fn painted(pixels: &[u8], x: usize) -> bool {
    let i = (ROW * W + x) * 4;
    let base = if figure(x, ROW) { FIGURE } else { WALL };
    pixels[i..i + 3] != [base, base, base]
}

#[test]
#[ignore = "requires a GPU adapter; run with --ignored"]
fn smart_mask_skips_the_figure_and_paints_all_the_wall_behind_it() {
    pollster::block_on(async {
        let gpu = Gpu::new(&wgpu::Instance::default(), None)
            .await
            .expect("GPU adapter");
        for mode in [Mode::Flat, Mode::Tilt, Mode::Warp] {
            for dense in [false, true] {
                let pixels = paint(&gpu, mode, true, dense).await;
                let case = format!("{mode:?}, dense={dense}");
                for leg in [140, 260] {
                    assert!(
                        !painted(&pixels, leg),
                        "{case}: paint landed on the leg at x={leg}"
                    );
                }
                assert!(
                    painted(&pixels, 200),
                    "{case}: the wall between the legs was skipped"
                );
                // Wall pixels three pixels from each silhouette edge: no halo.
                for x in [117, 163, 237, 283] {
                    assert!(
                        painted(&pixels, x),
                        "{case}: halo beside the figure at x={x}"
                    );
                }
                assert!(
                    painted(&pixels, 340),
                    "{case}: paint must continue past the figure"
                );
                assert!(
                    !painted(&pixels, 395),
                    "{case}: paint beyond the stroke's end"
                );
            }
        }
    });
}

#[test]
#[ignore = "requires a GPU adapter; run with --ignored"]
fn without_the_mask_the_brush_paints_over_the_figure() {
    pollster::block_on(async {
        let gpu = Gpu::new(&wgpu::Instance::default(), None)
            .await
            .expect("GPU adapter");
        for mode in [Mode::Flat, Mode::Tilt] {
            let pixels = paint(&gpu, mode, false, false).await;
            assert!(
                painted(&pixels, 140),
                "{mode:?}: an unmasked brush ignores occlusion"
            );
        }
    });
}

/// A wall above a floor, joined by a softened corner: depth and normals
/// change continuously from one to the other, and the colour is the same.
async fn paint_room(gpu: &Gpu, mode: Mode, path: &[(f32, f32)]) -> Vec<u8> {
    let rgba: Vec<u8> = (0..W * H).flat_map(|_| [WALL, WALL, WALL, 255]).collect();
    let (lw, lh) = (W / 2, H / 2);
    // Disparity is 0 on the wall and grows linearly down the floor, which
    // is what a flat floor looks like to a pinhole camera.
    let hard: Vec<f32> = (0..lw * lh)
        .map(|i| ((i / lw) as f32 - 40.0).max(0.0) / 40.0)
        .collect();
    let mut disparity = vec![0f32; lw * lh];
    for y in 0..lh {
        for x in 0..lw {
            let rows = y.saturating_sub(2)..(y + 3).min(lh);
            let n = rows.len() as f32;
            disparity[y * lw + x] = rows.map(|sy| hard[sy * lw + x]).sum::<f32>() / n;
        }
    }
    let mut editor = Editor::new(gpu);
    editor.load_image(gpu, &rgba, W, H);
    editor.set_depth(gpu, &disparity, lw, lh);
    editor.brush.mode = mode;
    editor.brush.radius = 6.0;
    editor.brush.hardness = 1.0;
    editor.brush.opacity = 1.0;
    editor.brush.color = [1.0, 0.0, 0.0];
    editor.begin_stroke(gpu, path[0].0, path[0].1);
    for pair in path.windows(2) {
        let ((x0, y0), (x1, y1)) = (pair[0], pair[1]);
        for step in 1..=200 {
            let t = step as f32 / 200.0;
            editor.extend_stroke(gpu, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t);
        }
    }
    editor.end_stroke(gpu);
    editor.render(gpu);
    editor.export(gpu).unwrap().read(gpu).await.unwrap()
}

#[test]
#[ignore = "requires a GPU adapter; run with --ignored"]
fn a_stroke_started_on_the_wall_does_not_creep_onto_the_floor() {
    pollster::block_on(async {
        let gpu = Gpu::new(&wgpu::Instance::default(), None)
            .await
            .expect("GPU adapter");
        let red = |pixels: &[u8], x: usize, y: usize| pixels[(y * W + x) * 4] != WALL;
        for mode in [Mode::Flat, Mode::Tilt, Mode::Warp] {
            // Straight down, and a shallow slide towards the corner first.
            let down = paint_room(&gpu, mode, &[(200.5, 50.5), (200.5, 150.5)]).await;
            let slide =
                paint_room(&gpu, mode, &[(60.5, 60.5), (220.5, 74.5), (300.5, 150.5)]).await;
            assert!(
                red(&down, 200, 55),
                "{mode:?}: the wall under the first dab"
            );
            assert!(red(&slide, 140, 67), "{mode:?}: the wall along the slide");
            for y in [110, 130, 145] {
                assert!(
                    !red(&down, 200, y),
                    "{mode:?}: straight stroke reached the floor at y={y}"
                );
            }
            assert!(
                !red(&slide, 272, 123),
                "{mode:?}: sliding stroke crept onto the floor"
            );
        }
    });
}

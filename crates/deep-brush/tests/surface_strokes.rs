#![cfg(not(target_arch = "wasm32"))]

use deep_brush::{
    editor::{Editor, Mode},
    gpu::Gpu,
};

#[test]
#[ignore = "requires a GPU adapter; run with --ignored"]
fn long_strokes_keep_the_starting_surface_independent_of_event_density() {
    pollster::block_on(async {
        let gpu = Gpu::new(&wgpu::Instance::default(), None)
            .await
            .expect("GPU adapter");
        // The long case crosses more than one instance-buffer batch.
        for width in [512usize, 2400] {
            let height = 128;
            let rgba = vec![180u8; width * height * 4];
            let centre = width / 2;
            let mut disparity = vec![0.0; width * height];
            for y in 16..height - 16 {
                for x in centre - 95..centre + 95 {
                    disparity[y * width + x] = ((x - (centre - 95)) as f32 / 80.0)
                        .min(((centre + 95) - x) as f32 / 80.0)
                        .min(1.0);
                }
            }
            for mode in [Mode::Flat, Mode::Tilt, Mode::Warp] {
                for dense in [false, true] {
                    let mut editor = Editor::new(&gpu);
                    editor.load_image(&gpu, &rgba, width, height);
                    editor.set_depth(&gpu, &disparity, width, height);
                    editor.brush.mode = mode;
                    editor.brush.radius = 2.0;
                    editor.brush.hardness = 1.0;
                    editor.brush.opacity = 1.0;
                    editor.brush.color = [1.0, 0.0, 0.0];
                    editor.begin_stroke(&gpu, 30.0, 64.0);
                    if dense {
                        for x in 31..width - 30 {
                            editor.extend_stroke(&gpu, x as f32, 64.0);
                        }
                    } else {
                        editor.extend_stroke(&gpu, (width - 31) as f32, 64.0);
                    }
                    editor.end_stroke(&gpu);
                    editor.render(&gpu);
                    let pixels = editor.export(&gpu).unwrap().read(&gpu).await.unwrap();
                    let changed = |x: usize| {
                        let i = (64 * width + x) * 4;
                        pixels[i..i + 3] != [180, 180, 180]
                    };
                    assert_eq!(
                        changed(centre),
                        mode == Mode::Flat,
                        "{mode:?}, dense={dense}, width={width}: wrong foreground coverage"
                    );
                    assert!(
                        changed(width - 80),
                        "{mode:?}, dense={dense}, width={width}: paint must resume on the wall"
                    );
                    assert!(
                        !changed(width - 5),
                        "stroke must not extend beyond the endpoint"
                    );
                }
            }
        }
    });
}

//! Scripted edits on one image, natively, for checking the brush engine.
//!
//! cargo run -p deep-brush --release --example paint -- <model.safetensors> <image> <out-dir>
//!
//! Writes the depth, normal, shading and albedo views and one PNG per edit.
//! Coordinates are fractions of the image size, chosen for the bundled
//! sample (public/lab/deep-brush/sample.jpg).

use deep_brush::depth::DepthModel;
use deep_brush::editor::{Editor, Layer, Mode, View};
use deep_brush::gpu::Gpu;
use deep_brush::preprocess;

fn save(
    gpu: &Gpu,
    editor: &mut Editor,
    view: View,
    path: std::path::PathBuf,
) -> Result<(), Box<dyn std::error::Error>> {
    editor.view = view;
    editor.render(gpu);
    let export = editor.export(gpu).ok_or("no document")?;
    let pixels = pollster::block_on(export.read(gpu))?;
    image::RgbaImage::from_raw(export.width as u32, export.height as u32, pixels)
        .ok_or("size mismatch")?
        .save(path)?;
    Ok(())
}

/// A test card: grid lines and a filled corner, so stretching is visible.
fn card(size: usize) -> Vec<u8> {
    let mut rgba = vec![0u8; size * size * 4];
    for y in 0..size {
        for x in 0..size {
            let i = (y * size + x) * 4;
            let line = x % (size / 8) < 3 || y % (size / 8) < 3 || x >= size - 3 || y >= size - 3;
            let corner = x < size / 4 && y < size / 4;
            let (c, a): ([u8; 3], u8) = if line {
                ([20, 40, 230], 255)
            } else if corner {
                ([230, 30, 40], 255)
            } else {
                ([250, 210, 20], 200)
            };
            rgba[i..i + 3].copy_from_slice(&c);
            rgba[i + 3] = a;
        }
    }
    rgba
}

fn stroke(gpu: &Gpu, editor: &mut Editor, points: &[(f32, f32)], w: f32, h: f32) {
    editor.begin_stroke(gpu, points[0].0 * w, points[0].1 * h);
    for &(x, y) in &points[1..] {
        editor.extend_stroke(gpu, x * w, y * h);
    }
    editor.end_stroke(gpu);
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    let [_, weights, image, out] = args.as_slice() else {
        return Err("usage: paint <model.safetensors> <image> <out-dir>".into());
    };
    let out = std::path::Path::new(out);
    std::fs::create_dir_all(out)?;
    let weights = std::fs::read(weights)?;
    let image = image::open(image)?.to_rgba8();
    let (iw, ih) = (image.width() as usize, image.height() as usize);
    let (w, h) = (iw as f32, ih as f32);

    let instance = wgpu::Instance::default();
    let gpu = pollster::block_on(Gpu::new(&instance, None))?;
    let model = DepthModel::load(&gpu, weights.len(), &|a, b| weights[a..b].to_vec())?;
    let mut editor = Editor::new(&gpu);
    editor.load_image(&gpu, image.as_raw(), iw, ih);

    let (mh, mw) = preprocess::model_size(iw, ih);
    let plan = model.plan(&gpu, mh, mw);
    model.submit(
        &gpu,
        &plan,
        &preprocess::image_tensor(image.as_raw(), iw, ih, mh, mw),
    );
    let disparity = pollster::block_on(plan.read(&gpu))?;
    editor.set_depth(&gpu, &disparity, mw, mh);

    for (view, name) in [
        (View::Depth, "depth"),
        (View::Normals, "normals"),
        (View::Shading, "shading"),
        (View::Albedo, "albedo"),
    ] {
        save(
            &gpu,
            &mut editor,
            view,
            out.join(format!("view-{name}.png")),
        )?;
    }

    // A wall stroke that passes behind the crouching figure.
    let across = [
        (0.04, 0.30),
        (0.20, 0.33),
        (0.40, 0.36),
        (0.60, 0.33),
        (0.78, 0.30),
    ];
    for mode in [Mode::Flat, Mode::Tilt, Mode::Warp] {
        editor.clear_layer(&gpu, Layer::Paint);
        editor.brush.mode = mode;
        editor.brush.radius = 26.0;
        editor.brush.color = [0.1, 0.55, 0.95];
        stroke(&gpu, &mut editor, &across, w, h);
        save(
            &gpu,
            &mut editor,
            View::Result,
            out.join(format!("stroke-{mode:?}.png").to_lowercase()),
        )?;
    }

    // A decal on the curved pillar, in each mode.
    editor.set_decal(&gpu, &card(256), 256, 256);
    for mode in [Mode::Flat, Mode::Tilt, Mode::Warp] {
        editor.clear_layer(&gpu, Layer::Paint);
        editor.brush.mode = mode;
        editor.brush.opacity = 1.0;
        editor.place_decal(&gpu, 0.905 * w, 0.42 * h, 0.085 * w, 0.0);
        editor.end_stroke(&gpu);
        save(
            &gpu,
            &mut editor,
            View::Result,
            out.join(format!("decal-{mode:?}.png").to_lowercase()),
        )?;
    }

    // Colour mask: a wide stroke that starts on the t-shirt keeps off the wall.
    editor.clear_layer(&gpu, Layer::Paint);
    editor.brush.mode = Mode::Warp;
    editor.brush.radius = 45.0;
    editor.brush.color = [0.85, 0.1, 0.15];
    editor.brush.color_mask = true;
    stroke(
        &gpu,
        &mut editor,
        &[(0.17, 0.33), (0.22, 0.38), (0.12, 0.45)],
        w,
        h,
    );
    editor.brush.color_mask = false;
    save(&gpu, &mut editor, View::Result, out.join("mask.png"))?;

    // Light: dim the photo, then paint a warm light onto the figure.
    editor.clear_layer(&gpu, Layer::Paint);
    editor.brush.layer = Layer::Light;
    editor.brush.color = [1.0, 0.7, 0.35];
    editor.brush.radius = 90.0;
    editor.brush.hardness = 0.0;
    editor.lighting.ambient = 0.45;
    editor.lighting.intensity = 2.0;
    editor.lighting.azimuth = 50.0;
    stroke(
        &gpu,
        &mut editor,
        &[(0.15, 0.2), (0.25, 0.35), (0.2, 0.55), (0.25, 0.7)],
        w,
        h,
    );
    save(&gpu, &mut editor, View::Result, out.join("light.png"))?;

    assert!(editor.undo(&gpu), "undo restores the light layer");
    save(
        &gpu,
        &mut editor,
        View::Result,
        out.join("light-undone.png"),
    )?;
    println!("wrote {}", out.display());
    Ok(())
}

//! Runs the depth model natively on one image.
//!
//! cargo run -p deep-brush --release --example depth -- <model.safetensors> <image> <out-dir>
//!
//! Writes `input.f32` (the normalized model input), `disparity.f32`, `size.txt`
//! (`height width`) and `disparity.png` to `out-dir`.

use std::time::Instant;

use deep_brush::depth::DepthModel;
use deep_brush::gpu::Gpu;
use deep_brush::preprocess;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    let [_, weights, image, out] = args.as_slice() else {
        return Err("usage: depth <model.safetensors> <image> <out-dir>".into());
    };
    let out = std::path::Path::new(out);
    std::fs::create_dir_all(out)?;
    let weights = std::fs::read(weights)?;
    let image = image::open(image)?.to_rgba8();
    let (iw, ih) = (image.width() as usize, image.height() as usize);

    let instance = wgpu::Instance::default();
    let gpu = pollster::block_on(Gpu::new(&instance, None))?;
    let started = Instant::now();
    let model = DepthModel::load(&gpu, weights.len(), &|a, b| weights[a..b].to_vec())?;
    println!("{}: weights uploaded in {:?}", gpu.name, started.elapsed());

    let (h, w) = preprocess::model_size(iw, ih);
    let tensor = preprocess::image_tensor(image.as_raw(), iw, ih, h, w);
    std::fs::write(out.join("input.f32"), bytemuck::cast_slice(&tensor))?;
    std::fs::write(out.join("size.txt"), format!("{h} {w}"))?;

    let plan = model.plan(&gpu, h, w);
    let mut disparity = Vec::new();
    for run in 0..3 {
        let started = Instant::now();
        model.submit(&gpu, &plan, &tensor);
        disparity = pollster::block_on(plan.read(&gpu))?;
        println!("run {run}: {w}x{h} in {:?}", started.elapsed());
    }
    std::fs::write(out.join("disparity.f32"), bytemuck::cast_slice(&disparity))?;

    let (lo, hi) = disparity
        .iter()
        .fold((f32::MAX, f32::MIN), |(lo, hi), &v| (lo.min(v), hi.max(v)));
    let pixels: Vec<u8> = disparity
        .iter()
        .map(|v| ((v - lo) / (hi - lo).max(1e-6) * 255.0) as u8)
        .collect();
    image::GrayImage::from_raw(w as u32, h as u32, pixels)
        .ok_or("disparity size mismatch")?
        .save(out.join("disparity.png"))?;
    println!("disparity range {lo} .. {hi}");
    Ok(())
}

//! The painting engine: per-image maps, the stroke buffer, the paint and
//! light layers, and the passes that combine them.
//!
//! Layers hold *surface* properties. Paint stores albedo (premultiplied
//! linear colour and coverage), so the composite re-applies the photo's
//! shading to it; light stores added illumination, which the composite
//! modulates by the surface normal and the albedo underneath.

use crate::geometry::{self, Geometry, V3};
use crate::gpu::{Gpu, read_buffer};

const PREPARE: &str = include_str!("shaders/edit/prepare.wgsl");
const STAMP: &str = include_str!("shaders/edit/stamp.wgsl");
const LAYERS: &str = include_str!("shaders/edit/layers.wgsl");

const LAYER_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba16Float;
const RESULT_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;
const UNDO_LEVELS: usize = 8;
const MAX_INSTANCES: usize = 1024;
/// Relative depth difference beyond which a pixel is off the anchored surface.
const SURFACE_TOLERANCE: f32 = 0.05;
/// Large-scale shading kept in the shading layer (see prepare.wgsl).
const SHADING_GAMMA: f32 = 0.6;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    Flat = 0,
    Tilt = 1,
    Warp = 2,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Layer {
    Paint,
    Light,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum View {
    Result = 0,
    Original = 1,
    Depth = 2,
    Normals = 3,
    Shading = 4,
    Albedo = 5,
}

#[derive(Clone, Debug)]
pub struct Brush {
    /// Radius in edit pixels.
    pub radius: f32,
    /// 0 is a soft falloff from the centre, 1 a hard edge.
    pub hardness: f32,
    pub opacity: f32,
    /// sRGB, 0..1.
    pub color: [f32; 3],
    pub mode: Mode,
    pub layer: Layer,
    pub erase: bool,
    /// Restrict painting to colours near the one under the stroke's start.
    pub color_mask: bool,
    pub mask_tolerance: f32,
}

impl Default for Brush {
    fn default() -> Self {
        Self {
            radius: 24.0,
            hardness: 0.6,
            opacity: 0.9,
            color: [0.95, 0.75, 0.1],
            mode: Mode::Tilt,
            layer: Layer::Paint,
            erase: false,
            color_mask: false,
            mask_tolerance: 0.18,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Lighting {
    /// Degrees; 0 is from the viewer, positive towards the right.
    pub azimuth: f32,
    /// Degrees above the horizon.
    pub elevation: f32,
    pub intensity: f32,
    /// Scale applied to the photo's own light.
    pub ambient: f32,
    /// Shade painted light with the surface normals.
    pub use_geometry: bool,
}

impl Default for Lighting {
    fn default() -> Self {
        Self {
            azimuth: -35.0,
            elevation: 25.0,
            intensity: 1.5,
            ambient: 1.0,
            use_geometry: true,
        }
    }
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Instance {
    a: [f32; 4],
    b: [f32; 4],
    c: [f32; 4],
    d: [f32; 4],
    e: [f32; 4],
    f: [f32; 4],
}

struct Stroke {
    layer: Layer,
    erase: bool,
    opacity: f32,
    last: (f32, f32),
    /// Distance walked since the last dab.
    carry: f32,
    anchor: Option<(V3, V3)>,
    /// Depth where the stroke's surface was last seen.
    surface_depth: f32,
}

struct Pipelines {
    normals: wgpu::ComputePipeline,
    downsample: wgpu::ComputePipeline,
    blur_x: wgpu::ComputePipeline,
    blur_y: wgpu::ComputePipeline,
    shading: wgpu::ComputePipeline,
    dab: wgpu::RenderPipeline,
    sticker: wgpu::RenderPipeline,
    commit_over: wgpu::RenderPipeline,
    commit_erase: wgpu::RenderPipeline,
    composite: wgpu::RenderPipeline,
    present: Vec<(wgpu::TextureFormat, wgpu::RenderPipeline)>,
    present_module: wgpu::ShaderModule,
    linear: wgpu::Sampler,
}

struct Target {
    texture: wgpu::Texture,
    view: wgpu::TextureView,
}

impl Target {
    fn new(
        gpu: &Gpu,
        label: &str,
        size: (usize, usize),
        format: wgpu::TextureFormat,
        usage: wgpu::TextureUsages,
    ) -> Self {
        let texture = gpu.device.create_texture(&wgpu::TextureDescriptor {
            label: Some(label),
            size: wgpu::Extent3d {
                width: size.0 as u32,
                height: size.1 as u32,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage,
            view_formats: &[],
        });
        let view = texture.create_view(&Default::default());
        Self { texture, view }
    }
}

/// Everything sized to one image.
struct Doc {
    width: usize,
    height: usize,
    rgba: Vec<u8>,
    geometry: Geometry,
    normal_step: f32,
    image: Target,
    depth: Target,
    normals: Target,
    shading: Target,
    lum_a: Target,
    lum_b: Target,
    paint: Target,
    light: Target,
    stroke: Target,
    result: Target,
    white: f32,
    undo: Vec<(Layer, wgpu::Texture)>,
    spare: Vec<wgpu::Texture>,
}

pub struct Editor {
    pipelines: Pipelines,
    scene_uniform: wgpu::Buffer,
    prepare_uniform: wgpu::Buffer,
    composite_uniform: wgpu::Buffer,
    commit_uniform: wgpu::Buffer,
    instances: wgpu::Buffer,
    decal: Target,
    decal_aspect: f32,
    doc: Option<Doc>,
    stroke: Option<Stroke>,
    pub brush: Brush,
    pub lighting: Lighting,
    pub view: View,
    /// The decal being positioned, if any: (x, y, half-width px, angle rad).
    decal_pose: Option<(f32, f32, f32, f32)>,
}

fn srgb_to_linear(c: f32) -> f32 {
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

fn words(values: &[f32]) -> Vec<u8> {
    let mut padded = values.to_vec();
    padded.resize(values.len().div_ceil(4) * 4, 0.0);
    bytemuck::cast_slice(&padded).to_vec()
}

fn module(gpu: &Gpu, label: &str, source: &str) -> wgpu::ShaderModule {
    gpu.device
        .create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some(label),
            source: wgpu::ShaderSource::Wgsl(source.into()),
        })
}

fn compute(gpu: &Gpu, module: &wgpu::ShaderModule, entry: &str) -> wgpu::ComputePipeline {
    gpu.device
        .create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some(entry),
            layout: None,
            module,
            entry_point: Some(entry),
            compilation_options: Default::default(),
            cache: None,
        })
}

const OVER: wgpu::BlendState = wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING;
const MAX: wgpu::BlendState = wgpu::BlendState {
    color: wgpu::BlendComponent {
        src_factor: wgpu::BlendFactor::One,
        dst_factor: wgpu::BlendFactor::One,
        operation: wgpu::BlendOperation::Max,
    },
    alpha: wgpu::BlendComponent {
        src_factor: wgpu::BlendFactor::One,
        dst_factor: wgpu::BlendFactor::One,
        operation: wgpu::BlendOperation::Max,
    },
};
const ERASE: wgpu::BlendState = wgpu::BlendState {
    color: wgpu::BlendComponent {
        src_factor: wgpu::BlendFactor::Zero,
        dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
        operation: wgpu::BlendOperation::Add,
    },
    alpha: wgpu::BlendComponent {
        src_factor: wgpu::BlendFactor::Zero,
        dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
        operation: wgpu::BlendOperation::Add,
    },
};

#[allow(clippy::too_many_arguments)]
fn render_pipeline(
    gpu: &Gpu,
    module: &wgpu::ShaderModule,
    vertex: &str,
    fragment: &str,
    buffers: &[Option<wgpu::VertexBufferLayout>],
    topology: wgpu::PrimitiveTopology,
    format: wgpu::TextureFormat,
    blend: Option<wgpu::BlendState>,
) -> wgpu::RenderPipeline {
    gpu.device
        .create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some(fragment),
            layout: None,
            vertex: wgpu::VertexState {
                module,
                entry_point: Some(vertex),
                compilation_options: Default::default(),
                buffers,
            },
            primitive: wgpu::PrimitiveState {
                topology,
                ..Default::default()
            },
            depth_stencil: None,
            multisample: Default::default(),
            fragment: Some(wgpu::FragmentState {
                module,
                entry_point: Some(fragment),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format,
                    blend,
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            multiview_mask: None,
            cache: None,
        })
}

impl Editor {
    pub fn new(gpu: &Gpu) -> Self {
        let prepare = module(gpu, "prepare", PREPARE);
        let stamp = module(gpu, "stamp", STAMP);
        let layers = module(gpu, "layers", LAYERS);
        let instance_layout = wgpu::VertexBufferLayout {
            array_stride: std::mem::size_of::<Instance>() as u64,
            step_mode: wgpu::VertexStepMode::Instance,
            attributes: &wgpu::vertex_attr_array![
                0 => Float32x4, 1 => Float32x4, 2 => Float32x4,
                3 => Float32x4, 4 => Float32x4, 5 => Float32x4
            ],
        };
        let strip = wgpu::PrimitiveTopology::TriangleStrip;
        let list = wgpu::PrimitiveTopology::TriangleList;
        let pipelines = Pipelines {
            normals: compute(gpu, &prepare, "normals"),
            downsample: compute(gpu, &prepare, "downsample"),
            blur_x: compute(gpu, &prepare, "blur_x"),
            blur_y: compute(gpu, &prepare, "blur_y"),
            shading: compute(gpu, &prepare, "shading"),
            dab: render_pipeline(
                gpu,
                &stamp,
                "vs",
                "dab",
                &[Some(instance_layout.clone())],
                strip,
                LAYER_FORMAT,
                Some(MAX),
            ),
            sticker: render_pipeline(
                gpu,
                &stamp,
                "vs",
                "sticker",
                &[Some(instance_layout)],
                strip,
                LAYER_FORMAT,
                Some(OVER),
            ),
            commit_over: render_pipeline(
                gpu,
                &layers,
                "fullscreen",
                "commit",
                &[],
                list,
                LAYER_FORMAT,
                Some(OVER),
            ),
            commit_erase: render_pipeline(
                gpu,
                &layers,
                "fullscreen",
                "commit",
                &[],
                list,
                LAYER_FORMAT,
                Some(ERASE),
            ),
            composite: render_pipeline(
                gpu,
                &layers,
                "fullscreen",
                "composite",
                &[],
                list,
                RESULT_FORMAT,
                None,
            ),
            present: Vec::new(),
            present_module: layers,
            linear: gpu.device.create_sampler(&wgpu::SamplerDescriptor {
                mag_filter: wgpu::FilterMode::Linear,
                min_filter: wgpu::FilterMode::Linear,
                ..Default::default()
            }),
        };
        let decal = Target::new(
            gpu,
            "decal",
            (1, 1),
            wgpu::TextureFormat::Rgba8Unorm,
            wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        );
        Self {
            pipelines,
            scene_uniform: gpu.uniform_init("scene", &[0u8; 48]),
            prepare_uniform: gpu.uniform_init("prepare", &[0u8; 48]),
            composite_uniform: gpu.uniform_init("composite", &[0u8; 48]),
            commit_uniform: gpu.uniform_init("commit", &[0u8; 16]),
            instances: gpu.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("instances"),
                size: (MAX_INSTANCES * std::mem::size_of::<Instance>()) as u64,
                usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            }),
            decal,
            decal_aspect: 1.0,
            doc: None,
            stroke: None,
            brush: Brush::default(),
            lighting: Lighting::default(),
            view: View::Result,
            decal_pose: None,
        }
    }

    /// The document's RGBA8 pixels and size.
    pub fn image(&self) -> Option<(&[u8], usize, usize)> {
        self.doc
            .as_ref()
            .map(|d| (d.rgba.as_slice(), d.width, d.height))
    }

    /// Starts a new document. Depth starts flat until [`Editor::set_depth`].
    pub fn load_image(&mut self, gpu: &Gpu, rgba: &[u8], width: usize, height: usize) {
        assert_eq!(rgba.len(), width * height * 4);
        use wgpu::TextureUsages as U;
        let size = (width, height);
        let quarter = (width.div_ceil(4), height.div_ceil(4));
        let layer = U::RENDER_ATTACHMENT | U::TEXTURE_BINDING | U::COPY_SRC | U::COPY_DST;
        let image = Target::new(
            gpu,
            "image",
            size,
            wgpu::TextureFormat::Rgba8Unorm,
            U::TEXTURE_BINDING | U::COPY_DST,
        );
        write_texture(gpu, &image.texture, rgba, width * 4, size);

        // White point: 95th percentile of linear luminance.
        let mut lum: Vec<f32> = rgba
            .chunks_exact(4)
            .step_by(13)
            .map(|p| {
                0.2126 * srgb_to_linear(p[0] as f32 / 255.0)
                    + 0.7152 * srgb_to_linear(p[1] as f32 / 255.0)
                    + 0.0722 * srgb_to_linear(p[2] as f32 / 255.0)
            })
            .collect();
        lum.sort_by(f32::total_cmp);
        let white = lum[((lum.len() - 1) as f32 * 0.95) as usize].max(0.05);

        let doc = Doc {
            width,
            height,
            rgba: rgba.to_vec(),
            geometry: Geometry::flat(width, height),
            normal_step: 2.0,
            image,
            depth: Target::new(
                gpu,
                "depth",
                size,
                wgpu::TextureFormat::R32Float,
                U::TEXTURE_BINDING | U::COPY_DST,
            ),
            normals: Target::new(
                gpu,
                "normals",
                size,
                wgpu::TextureFormat::Rgba16Float,
                U::STORAGE_BINDING | U::TEXTURE_BINDING,
            ),
            shading: Target::new(
                gpu,
                "shading",
                size,
                wgpu::TextureFormat::R32Float,
                U::STORAGE_BINDING | U::TEXTURE_BINDING,
            ),
            lum_a: Target::new(
                gpu,
                "lum_a",
                quarter,
                wgpu::TextureFormat::R32Float,
                U::STORAGE_BINDING | U::TEXTURE_BINDING,
            ),
            lum_b: Target::new(
                gpu,
                "lum_b",
                quarter,
                wgpu::TextureFormat::R32Float,
                U::STORAGE_BINDING | U::TEXTURE_BINDING,
            ),
            paint: Target::new(gpu, "paint", size, LAYER_FORMAT, layer),
            light: Target::new(gpu, "light", size, LAYER_FORMAT, layer),
            stroke: Target::new(gpu, "stroke", size, LAYER_FORMAT, layer),
            result: Target::new(
                gpu,
                "result",
                size,
                RESULT_FORMAT,
                U::RENDER_ATTACHMENT | U::TEXTURE_BINDING | U::COPY_SRC,
            ),
            white,
            undo: Vec::new(),
            spare: Vec::new(),
        };
        self.doc = Some(doc);
        self.stroke = None;
        self.decal_pose = None;
        let mut encoder = gpu.device.create_command_encoder(&Default::default());
        {
            let doc = self.doc.as_ref().expect("just set");
            for target in [&doc.paint, &doc.light, &doc.stroke] {
                clear(&mut encoder, &target.view);
            }
        }
        gpu.queue.submit([encoder.finish()]);
        self.upload_geometry(gpu);
    }

    /// Installs model-resolution disparity for the current document.
    pub fn set_depth(&mut self, gpu: &Gpu, disparity: &[f32], width: usize, height: usize) {
        let Some(doc) = self.doc.as_mut() else { return };
        doc.geometry = Geometry::from_disparity(disparity, width, height, doc.width, doc.height);
        doc.normal_step = doc.geometry.normal_step(width.max(height));
        self.upload_geometry(gpu);
    }

    /// Uploads depth, then recomputes normals and shading.
    fn upload_geometry(&mut self, gpu: &Gpu) {
        let Some(doc) = self.doc.as_ref() else { return };
        write_texture(
            gpu,
            &doc.depth.texture,
            bytemuck::cast_slice(&doc.geometry.depth),
            doc.width * 4,
            (doc.width, doc.height),
        );
        let quarter = (doc.width.div_ceil(4) as u32, doc.height.div_ceil(4) as u32);
        let sigma = 0.015 * doc.width.max(doc.height) as f32 / 4.0;
        let mut uniform = Vec::new();
        uniform.extend_from_slice(bytemuck::cast_slice(&[
            doc.width as u32,
            doc.height as u32,
            quarter.0,
            quarter.1,
        ]));
        uniform.extend_from_slice(&words(&[
            doc.geometry.focal,
            sigma,
            doc.white,
            SHADING_GAMMA,
            doc.normal_step,
            0.0,
            0.0,
            0.0,
        ]));
        gpu.queue.write_buffer(&self.prepare_uniform, 0, &uniform);

        let p = &self.pipelines;
        let bind = |pipeline: &wgpu::ComputePipeline, views: &[(u32, &wgpu::TextureView)]| {
            let mut entries = vec![wgpu::BindGroupEntry {
                binding: 0,
                resource: self.prepare_uniform.as_entire_binding(),
            }];
            entries.extend(views.iter().map(|(binding, view)| wgpu::BindGroupEntry {
                binding: *binding,
                resource: wgpu::BindingResource::TextureView(view),
            }));
            gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: None,
                layout: &pipeline.get_bind_group_layout(0),
                entries: &entries,
            })
        };
        let full = (doc.width.div_ceil(8) as u32, doc.height.div_ceil(8) as u32);
        let small = (quarter.0.div_ceil(8), quarter.1.div_ceil(8));
        let passes = [
            (
                &p.normals,
                bind(&p.normals, &[(1, &doc.depth.view), (2, &doc.normals.view)]),
                full,
            ),
            (
                &p.downsample,
                bind(&p.downsample, &[(3, &doc.image.view), (4, &doc.lum_a.view)]),
                small,
            ),
            (
                &p.blur_x,
                bind(&p.blur_x, &[(5, &doc.lum_a.view), (4, &doc.lum_b.view)]),
                small,
            ),
            (
                &p.blur_y,
                bind(&p.blur_y, &[(5, &doc.lum_b.view), (4, &doc.lum_a.view)]),
                small,
            ),
            (
                &p.shading,
                bind(
                    &p.shading,
                    &[
                        (3, &doc.image.view),
                        (5, &doc.lum_a.view),
                        (6, &doc.shading.view),
                    ],
                ),
                full,
            ),
        ];
        let mut encoder = gpu.device.create_command_encoder(&Default::default());
        for (pipeline, group, (x, y)) in &passes {
            let mut pass = encoder.begin_compute_pass(&Default::default());
            pass.set_pipeline(pipeline);
            pass.set_bind_group(0, group, &[]);
            pass.dispatch_workgroups(*x, *y, 1);
        }
        gpu.queue.submit([encoder.finish()]);
    }

    /// Replaces the decal with straight-alpha sRGB pixels.
    pub fn set_decal(&mut self, gpu: &Gpu, rgba: &[u8], width: usize, height: usize) {
        use wgpu::TextureUsages as U;
        self.decal = Target::new(
            gpu,
            "decal",
            (width, height),
            wgpu::TextureFormat::Rgba8Unorm,
            U::TEXTURE_BINDING | U::COPY_DST,
        );
        write_texture(gpu, &self.decal.texture, rgba, width * 4, (width, height));
        self.decal_aspect = height as f32 / width as f32;
    }

    fn write_scene(&self, gpu: &Gpu, mask: Option<[f32; 3]>) {
        let Some(doc) = self.doc.as_ref() else { return };
        let [r, g, b] = mask.unwrap_or([0.0; 3]);
        let values = [
            doc.width as f32,
            doc.height as f32,
            doc.geometry.focal,
            if mask.is_some() { 1.0 } else { 0.0 },
            r,
            g,
            b,
            self.brush.mask_tolerance,
            SURFACE_TOLERANCE,
            0.0,
            0.0,
            0.0,
        ];
        gpu.queue
            .write_buffer(&self.scene_uniform, 0, &words(&values));
    }

    fn mask_color(&self, x: f32, y: f32) -> Option<[f32; 3]> {
        let doc = self.doc.as_ref()?;
        if !self.brush.color_mask {
            return None;
        }
        let px = (x as usize).min(doc.width - 1);
        let py = (y as usize).min(doc.height - 1);
        let i = (py * doc.width + px) * 4;
        Some([0, 1, 2].map(|c| doc.rgba[i + c] as f32 / 255.0))
    }

    /// Anchor point and normal for a dab, held on the stroke's surface.
    ///
    /// While the pixel under the cursor stays on the tangent plane of the
    /// previous dab, the anchor follows it. When it jumps off (an occluder
    /// in front, or a different object), the anchor stays at the depth where
    /// the surface was last seen, and the stroke picks the surface up again
    /// once a pixel is back within `REACQUIRE` of that depth. Extrapolating
    /// the plane across the gap instead drifts: monocular normals are often
    /// off by tens of degrees.
    fn anchor(&mut self, x: f32, y: f32, normal_scale: f32) -> (V3, V3) {
        const REACQUIRE: f32 = 0.12;
        let doc = self.doc.as_ref().expect("document");
        let g = &doc.geometry;
        let step = doc.normal_step.max(normal_scale);
        let actual = g.position(x, y);
        let normal = g.normal(x, y, step);
        let previous = self
            .stroke
            .as_ref()
            .and_then(|s| s.anchor.map(|a| (a, s.surface_depth)));
        let (anchor, attached) = match previous {
            None => ((actual, normal), true),
            Some(((origin, n), seen)) => {
                let predicted = g.on_plane(x, y, origin, n);
                let on_plane = predicted[2] > 0.0
                    && (actual[2] - predicted[2]).abs() <= SURFACE_TOLERANCE * predicted[2];
                if on_plane || (actual[2] - seen).abs() <= REACQUIRE * seen {
                    // Mostly keep the stroke's normal: per-dab normals are noisy.
                    let blended = geometry::normalize(geometry::add(
                        geometry::scale(n, 0.85),
                        geometry::scale(normal, 0.15),
                    ));
                    ((actual, blended), true)
                } else {
                    ((geometry::scale(g.ray(x, y), seen), n), false)
                }
            }
        };
        if let Some(stroke) = self.stroke.as_mut() {
            stroke.anchor = Some(anchor);
            if attached {
                stroke.surface_depth = anchor.0[2];
            }
        }
        anchor
    }

    fn dab(&mut self, x: f32, y: f32) -> Instance {
        let brush = self.brush.clone();
        let color = match (brush.layer, brush.erase) {
            (_, true) => [1.0; 3],
            _ => brush.color.map(srgb_to_linear),
        };
        let f = [color[0], color[1], color[2], 0.0];
        let r = brush.radius;
        if brush.mode == Mode::Flat {
            return Instance {
                a: [x, y, r * 1.05, 0.0],
                b: [0.0, 0.0, 0.0, r],
                c: [0.0, 0.0, -1.0, 0.0],
                d: [1.0, 0.0, 0.0, 1.0],
                e: [0.0, 1.0, 0.0, brush.hardness],
                f,
            };
        }
        let (p, n) = self.anchor(x, y, r / 3.0);
        let focal = self.doc.as_ref().expect("document").geometry.focal;
        let (t, b) = geometry::tangent_frame(n, 0.0);
        Instance {
            a: [x, y, r * 1.6, 0.0],
            b: [p[0], p[1], p[2], r * p[2] / focal],
            c: [n[0], n[1], n[2], brush.mode as u32 as f32],
            d: [t[0], t[1], t[2], 1.0],
            e: [b[0], b[1], b[2], brush.hardness],
            f,
        }
    }

    pub fn begin_stroke(&mut self, gpu: &Gpu, x: f32, y: f32) {
        if self.doc.is_none() {
            return;
        }
        self.cancel_decal(gpu);
        self.stroke = Some(Stroke {
            layer: self.brush.layer,
            erase: self.brush.erase,
            opacity: self.brush.opacity,
            last: (x, y),
            carry: 0.0,
            anchor: None,
            surface_depth: 0.0,
        });
        self.write_scene(gpu, self.mask_color(x, y));
        let mut encoder = gpu.device.create_command_encoder(&Default::default());
        clear(
            &mut encoder,
            &self.doc.as_ref().expect("document").stroke.view,
        );
        gpu.queue.submit([encoder.finish()]);
        let dab = self.dab(x, y);
        self.draw(gpu, &[dab], false);
    }

    pub fn extend_stroke(&mut self, gpu: &Gpu, x: f32, y: f32) {
        let Some(stroke) = self.stroke.as_ref() else {
            return;
        };
        let spacing = (self.brush.radius * 0.15).max(1.0);
        let (lx, ly) = stroke.last;
        let (dx, dy) = (x - lx, y - ly);
        let length = (dx * dx + dy * dy).sqrt();
        let mut walked = spacing - stroke.carry;
        let mut dabs = Vec::new();
        while walked <= length {
            let t = walked / length;
            dabs.push(self.dab(lx + dx * t, ly + dy * t));
            walked += spacing;
        }
        let stroke = self.stroke.as_mut().expect("stroke");
        stroke.carry = length - (walked - spacing);
        stroke.last = (x, y);
        for chunk in dabs.chunks(MAX_INSTANCES) {
            self.draw(gpu, chunk, false);
        }
    }

    /// Merges the stroke (or the placed decal) into its layer.
    pub fn end_stroke(&mut self, gpu: &Gpu) {
        let Some(stroke) = self.stroke.take() else {
            return;
        };
        self.decal_pose = None;
        self.snapshot(gpu, stroke.layer);
        let doc = self.doc.as_ref().expect("document");
        let target = match stroke.layer {
            Layer::Paint => &doc.paint.view,
            Layer::Light => &doc.light.view,
        };
        gpu.queue
            .write_buffer(&self.commit_uniform, 0, &words(&[stroke.opacity]));
        let pipeline = if stroke.erase {
            &self.pipelines.commit_erase
        } else {
            &self.pipelines.commit_over
        };
        let group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &pipeline.get_bind_group_layout(0),
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: self.commit_uniform.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(&doc.stroke.view),
                },
            ],
        });
        let mut encoder = gpu.device.create_command_encoder(&Default::default());
        {
            let mut pass = begin(&mut encoder, target, wgpu::LoadOp::Load);
            pass.set_pipeline(pipeline);
            pass.set_bind_group(0, &group, &[]);
            pass.draw(0..3, 0..1);
        }
        clear(&mut encoder, &doc.stroke.view);
        gpu.queue.submit([encoder.finish()]);
    }

    /// Positions the decal (half-width in px, angle in radians) as a live
    /// preview on the paint layer. [`Editor::end_stroke`] applies it.
    pub fn place_decal(&mut self, gpu: &Gpu, x: f32, y: f32, half_width: f32, angle: f32) {
        if self.doc.is_none() {
            return;
        }
        self.decal_pose = Some((x, y, half_width, angle));
        self.stroke = Some(Stroke {
            layer: Layer::Paint,
            erase: false,
            opacity: self.brush.opacity,
            last: (x, y),
            carry: 0.0,
            anchor: None,
            surface_depth: 0.0,
        });
        self.write_scene(gpu, self.mask_color(x, y));
        let aspect = self.decal_aspect;
        let extent = half_width * aspect.max(1.0) * 1.8;
        let instance = if self.brush.mode == Mode::Flat {
            let (s, c) = angle.sin_cos();
            Instance {
                a: [x, y, extent, 1.0],
                b: [0.0, 0.0, 0.0, half_width],
                c: [0.0, 0.0, -1.0, 0.0],
                d: [c, s, 0.0, aspect],
                e: [-s, c, 0.0, 0.0],
                f: [0.0; 4],
            }
        } else {
            let (p, n) = self.anchor(x, y, half_width / 4.0);
            let focal = self.doc.as_ref().expect("document").geometry.focal;
            let (t, b) = geometry::tangent_frame(n, angle);
            Instance {
                a: [x, y, extent, 1.0],
                b: [p[0], p[1], p[2], half_width * p[2] / focal],
                c: [n[0], n[1], n[2], self.brush.mode as u32 as f32],
                d: [t[0], t[1], t[2], aspect],
                e: [b[0], b[1], b[2], 0.0],
                f: [0.0; 4],
            }
        };
        self.draw(gpu, &[instance], true);
    }

    pub fn cancel_decal(&mut self, gpu: &Gpu) {
        if self.decal_pose.take().is_none() {
            return;
        }
        self.stroke = None;
        if let Some(doc) = self.doc.as_ref() {
            let mut encoder = gpu.device.create_command_encoder(&Default::default());
            clear(&mut encoder, &doc.stroke.view);
            gpu.queue.submit([encoder.finish()]);
        }
    }

    pub fn decal_pose(&self) -> Option<(f32, f32, f32, f32)> {
        self.decal_pose
    }

    fn draw(&self, gpu: &Gpu, instances: &[Instance], sticker: bool) {
        let Some(doc) = self.doc.as_ref() else { return };
        if instances.is_empty() {
            return;
        }
        gpu.queue
            .write_buffer(&self.instances, 0, bytemuck::cast_slice(instances));
        let pipeline = if sticker {
            &self.pipelines.sticker
        } else {
            &self.pipelines.dab
        };
        let mut entries = vec![
            wgpu::BindGroupEntry {
                binding: 0,
                resource: self.scene_uniform.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: wgpu::BindingResource::TextureView(&doc.depth.view),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: wgpu::BindingResource::TextureView(&doc.normals.view),
            },
            wgpu::BindGroupEntry {
                binding: 3,
                resource: wgpu::BindingResource::TextureView(&doc.image.view),
            },
        ];
        if sticker {
            entries.push(wgpu::BindGroupEntry {
                binding: 4,
                resource: wgpu::BindingResource::TextureView(&self.decal.view),
            });
            entries.push(wgpu::BindGroupEntry {
                binding: 5,
                resource: wgpu::BindingResource::Sampler(&self.pipelines.linear),
            });
        }
        let group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &pipeline.get_bind_group_layout(0),
            entries: &entries,
        });
        let mut encoder = gpu.device.create_command_encoder(&Default::default());
        {
            let load = if sticker {
                wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT)
            } else {
                wgpu::LoadOp::Load
            };
            let mut pass = begin(&mut encoder, &doc.stroke.view, load);
            pass.set_pipeline(pipeline);
            pass.set_bind_group(0, &group, &[]);
            pass.set_vertex_buffer(0, self.instances.slice(..));
            pass.draw(0..4, 0..instances.len() as u32);
        }
        gpu.queue.submit([encoder.finish()]);
    }

    fn snapshot(&mut self, gpu: &Gpu, layer: Layer) {
        let Some(doc) = self.doc.as_mut() else { return };
        let texture = doc.spare.pop().unwrap_or_else(|| {
            gpu.device.create_texture(&wgpu::TextureDescriptor {
                label: Some("undo"),
                size: doc.paint.texture.size(),
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: LAYER_FORMAT,
                usage: wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            })
        });
        let source = match layer {
            Layer::Paint => &doc.paint.texture,
            Layer::Light => &doc.light.texture,
        };
        let mut encoder = gpu.device.create_command_encoder(&Default::default());
        encoder.copy_texture_to_texture(
            source.as_image_copy(),
            texture.as_image_copy(),
            source.size(),
        );
        gpu.queue.submit([encoder.finish()]);
        doc.undo.push((layer, texture));
        if doc.undo.len() > UNDO_LEVELS {
            let (_, oldest) = doc.undo.remove(0);
            doc.spare.push(oldest);
        }
    }

    /// Restores the layer state before the last stroke or clear.
    pub fn undo(&mut self, gpu: &Gpu) -> bool {
        self.cancel_decal(gpu);
        let Some(doc) = self.doc.as_mut() else {
            return false;
        };
        let Some((layer, texture)) = doc.undo.pop() else {
            return false;
        };
        let target = match layer {
            Layer::Paint => &doc.paint.texture,
            Layer::Light => &doc.light.texture,
        };
        let mut encoder = gpu.device.create_command_encoder(&Default::default());
        encoder.copy_texture_to_texture(
            texture.as_image_copy(),
            target.as_image_copy(),
            target.size(),
        );
        gpu.queue.submit([encoder.finish()]);
        doc.spare.push(texture);
        true
    }

    pub fn can_undo(&self) -> bool {
        self.doc.as_ref().is_some_and(|d| !d.undo.is_empty())
    }

    pub fn clear_layer(&mut self, gpu: &Gpu, layer: Layer) {
        if self.doc.is_none() {
            return;
        }
        self.cancel_decal(gpu);
        self.snapshot(gpu, layer);
        let doc = self.doc.as_ref().expect("document");
        let view = match layer {
            Layer::Paint => &doc.paint.view,
            Layer::Light => &doc.light.view,
        };
        let mut encoder = gpu.device.create_command_encoder(&Default::default());
        clear(&mut encoder, view);
        gpu.queue.submit([encoder.finish()]);
    }

    /// Composites into the result texture at the edit resolution.
    pub fn render(&self, gpu: &Gpu) {
        let Some(doc) = self.doc.as_ref() else { return };
        let l = &self.lighting;
        let (az, el) = (l.azimuth.to_radians(), l.elevation.to_radians());
        // Viewer frame (x right, y up, z towards the viewer) to camera space.
        let dir = [az.sin() * el.cos(), -el.sin(), -az.cos() * el.cos()];
        let preview = match &self.stroke {
            None => 0u32,
            Some(s) => match (s.layer, s.erase) {
                (Layer::Paint, false) => 1,
                (Layer::Light, false) => 2,
                (Layer::Paint, true) => 3,
                (Layer::Light, true) => 4,
            },
        };
        let opacity = self.stroke.as_ref().map_or(0.0, |s| s.opacity);
        let mut uniform = Vec::new();
        uniform.extend_from_slice(&words(&[dir[0], dir[1], dir[2]]));
        uniform[12..16].copy_from_slice(&(self.view as u32).to_le_bytes());
        uniform.extend_from_slice(bytemuck::cast_slice(&[
            l.intensity,
            l.ambient,
            if l.use_geometry { 1.0 } else { 0.0 },
            f32::from_bits(preview),
            opacity,
            geometry::NEAR_DEPTH,
            geometry::FAR_DEPTH,
            0.0,
        ]));
        gpu.queue.write_buffer(&self.composite_uniform, 0, &uniform);
        let views = [
            &doc.image.view,
            &doc.depth.view,
            &doc.normals.view,
            &doc.shading.view,
            &doc.paint.view,
            &doc.light.view,
            &doc.stroke.view,
        ];
        let mut entries = vec![wgpu::BindGroupEntry {
            binding: 0,
            resource: self.composite_uniform.as_entire_binding(),
        }];
        entries.extend(
            views
                .iter()
                .enumerate()
                .map(|(i, view)| wgpu::BindGroupEntry {
                    binding: i as u32 + 1,
                    resource: wgpu::BindingResource::TextureView(view),
                }),
        );
        let group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &self.pipelines.composite.get_bind_group_layout(0),
            entries: &entries,
        });
        let mut encoder = gpu.device.create_command_encoder(&Default::default());
        {
            let mut pass = begin(
                &mut encoder,
                &doc.result.view,
                wgpu::LoadOp::Clear(wgpu::Color::BLACK),
            );
            pass.set_pipeline(&self.pipelines.composite);
            pass.set_bind_group(0, &group, &[]);
            pass.draw(0..3, 0..1);
        }
        gpu.queue.submit([encoder.finish()]);
    }

    /// Draws the last [`Editor::render`] result scaled to `target`.
    pub fn present(&mut self, gpu: &Gpu, target: &wgpu::TextureView, format: wgpu::TextureFormat) {
        let Some(doc) = self.doc.as_ref() else { return };
        if !self.pipelines.present.iter().any(|(f, _)| *f == format) {
            let pipeline = render_pipeline(
                gpu,
                &self.pipelines.present_module,
                "fullscreen",
                "present",
                &[],
                wgpu::PrimitiveTopology::TriangleList,
                format,
                None,
            );
            self.pipelines.present.push((format, pipeline));
        }
        let pipeline = &self
            .pipelines
            .present
            .iter()
            .find(|(f, _)| *f == format)
            .expect("inserted")
            .1;
        let group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &pipeline.get_bind_group_layout(0),
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&doc.result.view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&self.pipelines.linear),
                },
            ],
        });
        let mut encoder = gpu.device.create_command_encoder(&Default::default());
        {
            let mut pass = begin(
                &mut encoder,
                target,
                wgpu::LoadOp::Clear(wgpu::Color::BLACK),
            );
            pass.set_pipeline(pipeline);
            pass.set_bind_group(0, &group, &[]);
            pass.draw(0..3, 0..1);
        }
        gpu.queue.submit([encoder.finish()]);
    }

    /// Queues a copy of the result; await [`Export::read`] for the pixels.
    pub fn export(&self, gpu: &Gpu) -> Option<Export> {
        let doc = self.doc.as_ref()?;
        let row = (doc.width * 4).div_ceil(256) * 256;
        let buffer = gpu.readback("export", (row * doc.height) as u64);
        let mut encoder = gpu.device.create_command_encoder(&Default::default());
        encoder.copy_texture_to_buffer(
            doc.result.texture.as_image_copy(),
            wgpu::TexelCopyBufferInfo {
                buffer: &buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(row as u32),
                    rows_per_image: Some(doc.height as u32),
                },
            },
            doc.result.texture.size(),
        );
        gpu.queue.submit([encoder.finish()]);
        Some(Export {
            buffer,
            width: doc.width,
            height: doc.height,
            row,
        })
    }
}

/// A pending readback of the composite.
pub struct Export {
    buffer: wgpu::Buffer,
    pub width: usize,
    pub height: usize,
    row: usize,
}

impl Export {
    /// RGBA8 sRGB pixels, tightly packed.
    pub async fn read(&self, gpu: &Gpu) -> Result<Vec<u8>, String> {
        let padded = read_buffer(gpu, &self.buffer).await?;
        let mut pixels = Vec::with_capacity(self.width * self.height * 4);
        for y in 0..self.height {
            pixels.extend_from_slice(&padded[y * self.row..][..self.width * 4]);
        }
        Ok(pixels)
    }
}

fn write_texture(
    gpu: &Gpu,
    texture: &wgpu::Texture,
    bytes: &[u8],
    row: usize,
    size: (usize, usize),
) {
    gpu.queue.write_texture(
        texture.as_image_copy(),
        bytes,
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(row as u32),
            rows_per_image: Some(size.1 as u32),
        },
        wgpu::Extent3d {
            width: size.0 as u32,
            height: size.1 as u32,
            depth_or_array_layers: 1,
        },
    );
}

fn begin<'a>(
    encoder: &'a mut wgpu::CommandEncoder,
    view: &wgpu::TextureView,
    load: wgpu::LoadOp<wgpu::Color>,
) -> wgpu::RenderPass<'a> {
    encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: None,
        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
            view,
            depth_slice: None,
            resolve_target: None,
            ops: wgpu::Operations {
                load,
                store: wgpu::StoreOp::Store,
            },
        })],
        depth_stencil_attachment: None,
        timestamp_writes: None,
        occlusion_query_set: None,
        multiview_mask: None,
    })
}

fn clear(encoder: &mut wgpu::CommandEncoder, view: &wgpu::TextureView) {
    begin(encoder, view, wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT));
}

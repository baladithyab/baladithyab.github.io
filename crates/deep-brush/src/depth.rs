//! Depth Anything V2 Small (DINOv2 ViT-S/14 encoder + DPT head) as WGSL
//! compute passes. Weights come from the Hugging Face checkpoint
//! `depth-anything/Depth-Anything-V2-Small-hf`; layer names and the order of
//! operations follow `transformers`' `DepthAnythingForDepthEstimation`.
//!
//! The output is relative inverse depth (disparity): larger is closer, with
//! an unknown scale and shift.

use std::collections::HashMap;

use crate::gpu::{Gpu, read_buffer};
use crate::preprocess::{self, PATCH};
use crate::safetensors::{Header, to_f32};

const DIM: usize = 384;
const HEADS: usize = 6;
const LAYERS: usize = 12;
const MLP: usize = 1536;
/// Encoder layers (0-based) whose outputs feed the neck: stages 3, 6, 9, 12.
const STAGES: [usize; 4] = [2, 5, 8, 11];
const NECK: [usize; 4] = [48, 96, 192, 384];
const FUSION: usize = 64;
const HEAD_HIDDEN: usize = 32;
const LAYER_NORM_EPS: f32 = 1e-6;

const LINEAR: &str = include_str!("shaders/model/linear.wgsl");
const LAYER_NORM: &str = include_str!("shaders/model/layernorm.wgsl");
const ATTENTION: &str = include_str!("shaders/model/attention.wgsl");
const CONV2D: &str = include_str!("shaders/model/conv2d.wgsl");
const RESHAPE: &str = include_str!("shaders/model/reshape.wgsl");

const BIAS: u32 = 1;
const RELU_IN: u32 = 2;
const RELU_OUT: u32 = 4;
const RES_A: u32 = 8;
const RES_B: u32 = 16;

struct Kernels {
    linear: wgpu::ComputePipeline,
    layer_norm: wgpu::ComputePipeline,
    attention: wgpu::ComputePipeline,
    conv2d: wgpu::ComputePipeline,
    embed: wgpu::ComputePipeline,
    tokens_to_chw: wgpu::ComputePipeline,
    conv_transpose: wgpu::ComputePipeline,
    resize: wgpu::ComputePipeline,
}

pub struct DepthModel {
    kernels: Kernels,
    weights: HashMap<String, wgpu::Buffer>,
    /// Kept on the CPU: resized to each input's patch grid.
    position: Vec<f32>,
    empty: wgpu::Buffer,
}

/// The dispatch list and activation buffers for one input size.
pub struct Plan {
    ops: Vec<Op>,
    input: wgpu::Buffer,
    output: wgpu::Buffer,
    staging: wgpu::Buffer,
    pub height: usize,
    pub width: usize,
}

struct Op {
    pipeline: wgpu::ComputePipeline,
    bind_group: wgpu::BindGroup,
    groups: [u32; 3],
}

/// A CHW feature map.
#[derive(Clone)]
struct Map {
    buf: wgpu::Buffer,
    c: usize,
    h: usize,
    w: usize,
}

fn groups(n: usize, size: usize) -> u32 {
    n.div_ceil(size) as u32
}

fn bytes(floats: usize) -> u64 {
    (floats * 4) as u64
}

impl DepthModel {
    /// `read(start, end)` returns that byte range of the safetensors file.
    pub fn load(
        gpu: &Gpu,
        file_len: usize,
        read: &dyn Fn(usize, usize) -> Vec<u8>,
    ) -> Result<Self, String> {
        let header = Header::parse(file_len, read)?;
        let fetch = |name: &str| -> Result<Vec<f32>, String> {
            let t = header.get(name)?;
            Ok(to_f32(&read(t.start, t.end)))
        };
        let mut weights = HashMap::new();
        let mut upload = |name: String, data: Vec<f32>| {
            let buffer = gpu.storage_init(&name, &data);
            weights.insert(name, buffer);
        };

        let mut names = vec![
            "backbone.embeddings.cls_token".to_string(),
            "backbone.embeddings.patch_embeddings.projection.weight".into(),
            "backbone.embeddings.patch_embeddings.projection.bias".into(),
            "backbone.layernorm.weight".into(),
            "backbone.layernorm.bias".into(),
        ];
        for l in 0..LAYERS {
            let pre = format!("backbone.encoder.layer.{l}.");
            for part in [
                "norm1.weight",
                "norm1.bias",
                "attention.output.dense.weight",
                "attention.output.dense.bias",
                "layer_scale1.lambda1",
                "norm2.weight",
                "norm2.bias",
                "mlp.fc1.weight",
                "mlp.fc1.bias",
                "mlp.fc2.weight",
                "mlp.fc2.bias",
                "layer_scale2.lambda1",
            ] {
                names.push(format!("{pre}{part}"));
            }
            // One matmul produces q, k and v.
            for kind in ["weight", "bias"] {
                let mut packed = Vec::new();
                for proj in ["query", "key", "value"] {
                    packed.extend(fetch(&format!("{pre}attention.attention.{proj}.{kind}"))?);
                }
                upload(format!("{pre}qkv.{kind}"), packed);
            }
        }
        for k in 0..4 {
            let pre = format!("neck.reassemble_stage.layers.{k}.");
            names.push(format!("{pre}projection.weight"));
            names.push(format!("{pre}projection.bias"));
            if k != 2 {
                names.push(format!("{pre}resize.weight"));
                names.push(format!("{pre}resize.bias"));
            }
            names.push(format!("neck.convs.{k}.weight"));
            let pre = format!("neck.fusion_stage.layers.{k}.");
            names.push(format!("{pre}projection.weight"));
            names.push(format!("{pre}projection.bias"));
            for unit in ["residual_layer1", "residual_layer2"] {
                for conv in ["convolution1", "convolution2"] {
                    names.push(format!("{pre}{unit}.{conv}.weight"));
                    names.push(format!("{pre}{unit}.{conv}.bias"));
                }
            }
        }
        for conv in ["conv1", "conv2", "conv3"] {
            names.push(format!("head.{conv}.weight"));
            names.push(format!("head.{conv}.bias"));
        }
        for name in names {
            let data = fetch(&name)?;
            upload(name, data);
        }
        let position = fetch("backbone.embeddings.position_embeddings")?;

        let kernels = Kernels {
            linear: gpu.compute_pipeline("linear", LINEAR),
            layer_norm: gpu.compute_pipeline("layer_norm", LAYER_NORM),
            attention: gpu.compute_pipeline("attention", ATTENTION),
            conv2d: gpu.compute_pipeline("conv2d", CONV2D),
            embed: entry(gpu, "embed"),
            tokens_to_chw: entry(gpu, "tokens_to_chw"),
            conv_transpose: entry(gpu, "conv_transpose"),
            resize: entry(gpu, "resize"),
        };
        Ok(Self {
            kernels,
            weights,
            position,
            empty: gpu.storage("empty", 4),
        })
    }

    fn w(&self, name: &str) -> &wgpu::Buffer {
        // Every name used below was validated in `load`.
        &self.weights[name]
    }

    fn op(
        &self,
        gpu: &Gpu,
        pipeline: &wgpu::ComputePipeline,
        params: &[u32],
        bindings: &[(u32, &wgpu::Buffer)],
        groups: [u32; 3],
    ) -> Op {
        // Every kernel's parameter block fits in 12 words; padding to that
        // satisfies each shader's minimum binding size.
        let mut words = params.to_vec();
        words.resize(12, 0);
        let uniform = gpu.uniform_init("params", bytemuck::cast_slice(&words));
        let mut entries = vec![wgpu::BindGroupEntry {
            binding: 0,
            resource: uniform.as_entire_binding(),
        }];
        entries.extend(
            bindings
                .iter()
                .map(|(binding, buffer)| wgpu::BindGroupEntry {
                    binding: *binding,
                    resource: buffer.as_entire_binding(),
                }),
        );
        let bind_group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &pipeline.get_bind_group_layout(0),
            entries: &entries,
        });
        Op {
            pipeline: pipeline.clone(),
            bind_group,
            groups,
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn linear(
        &self,
        gpu: &Gpu,
        x: &wgpu::Buffer,
        weight: &str,
        rows: usize,
        out: usize,
        inner: usize,
        epilogue: u32,
        scale_residual: Option<(&str, &wgpu::Buffer)>,
        y: &wgpu::Buffer,
    ) -> Op {
        let (scale, residual) = match scale_residual {
            Some((scale, residual)) => (self.w(scale), residual),
            None => (&self.empty, &self.empty),
        };
        let bias = format!("{}.bias", weight.trim_end_matches(".weight"));
        self.op(
            gpu,
            &self.kernels.linear,
            &[rows as u32, out as u32, inner as u32, epilogue],
            &[
                (1, x),
                (2, self.w(weight)),
                (3, self.w(&bias)),
                (4, scale),
                (5, residual),
                (6, y),
            ],
            [groups(out, 64), groups(rows, 64), 1],
        )
    }

    fn layer_norm(
        &self,
        gpu: &Gpu,
        x: &wgpu::Buffer,
        prefix: &str,
        rows: usize,
        y: &wgpu::Buffer,
    ) -> Op {
        self.op(
            gpu,
            &self.kernels.layer_norm,
            &[rows as u32, DIM as u32, LAYER_NORM_EPS.to_bits()],
            &[
                (1, x),
                (2, self.w(&format!("{prefix}.weight"))),
                (3, self.w(&format!("{prefix}.bias"))),
                (4, y),
            ],
            [rows as u32, 1, 1],
        )
    }

    /// Convolution with PyTorch `Conv2d` semantics. `weight` names the
    /// parameter; its `.bias` sibling is used when `flags` has `BIAS`.
    #[allow(clippy::too_many_arguments)]
    fn conv(
        &self,
        gpu: &Gpu,
        input: &Map,
        weight: &str,
        cout: usize,
        kernel: usize,
        stride: usize,
        pad: usize,
        flags: u32,
        residuals: (Option<&wgpu::Buffer>, Option<&wgpu::Buffer>),
        output: &wgpu::Buffer,
    ) -> (Op, Map) {
        let hout = (input.h + 2 * pad - kernel) / stride + 1;
        let wout = (input.w + 2 * pad - kernel) / stride + 1;
        let bias_name = format!("{}.bias", weight.trim_end_matches(".weight"));
        let bias = if flags & BIAS != 0 {
            self.w(&bias_name)
        } else {
            &self.empty
        };
        let mut flags = flags;
        if residuals.0.is_some() {
            flags |= RES_A;
        }
        if residuals.1.is_some() {
            flags |= RES_B;
        }
        let op = self.op(
            gpu,
            &self.kernels.conv2d,
            &[
                input.c as u32,
                input.h as u32,
                input.w as u32,
                cout as u32,
                hout as u32,
                wout as u32,
                kernel as u32,
                kernel as u32,
                stride as u32,
                pad as u32,
                flags,
            ],
            &[
                (1, &input.buf),
                (2, self.w(weight)),
                (3, bias),
                (4, residuals.0.unwrap_or(&self.empty)),
                (5, residuals.1.unwrap_or(&self.empty)),
                (6, output),
            ],
            [groups(wout, 8), groups(hout, 8), groups(cout, 4)],
        );
        (
            op,
            Map {
                buf: output.clone(),
                c: cout,
                h: hout,
                w: wout,
            },
        )
    }

    fn resize(
        &self,
        gpu: &Gpu,
        input: &Map,
        h: usize,
        w: usize,
        output: &wgpu::Buffer,
    ) -> (Op, Map) {
        let op = self.op(
            gpu,
            &self.kernels.resize,
            &[
                input.c as u32,
                input.h as u32,
                input.w as u32,
                h as u32,
                w as u32,
                1,
            ],
            &[(1, &input.buf), (4, output)],
            [groups(w, 8), groups(h, 8), input.c as u32],
        );
        (
            op,
            Map {
                buf: output.clone(),
                c: input.c,
                h,
                w,
            },
        )
    }

    pub fn plan(&self, gpu: &Gpu, height: usize, width: usize) -> Plan {
        assert!(height % PATCH == 0 && width % PATCH == 0);
        let (ph, pw) = (height / PATCH, width / PATCH);
        let patches = ph * pw;
        let tokens = patches + 1;
        let (h3, w3) = ((ph - 1) / 2 + 1, (pw - 1) / 2 + 1);
        let storage = |label: &str, floats: usize| gpu.storage(label, bytes(floats));

        let input = storage("input", 3 * height * width);
        let patch = storage("patch", DIM * patches);
        let pos = gpu.storage_init(
            "position",
            &preprocess::position_embeddings(&self.position, DIM, ph, pw),
        );
        let h_a = storage("hidden_a", tokens * DIM);
        let h_b = storage("hidden_b", tokens * DIM);
        let normed = storage("normed", tokens * DIM);
        let qkv = storage("qkv", tokens * 3 * DIM);
        let attended = storage("attended", tokens * DIM);
        let mlp = storage("mlp", tokens * MLP);
        let chw = storage("chw", DIM * patches);
        let projected = storage("projected", DIM * patches);
        let resized = storage("resized", (48 * 16 * patches).max(DIM * h3 * w3));
        let stage_sizes = [(4 * ph, 4 * pw), (2 * ph, 2 * pw), (ph, pw), (h3, w3)];
        let features: Vec<wgpu::Buffer> = stage_sizes
            .iter()
            .map(|(h, w)| storage("feature", FUSION * h * w))
            .collect();
        let t_a = storage("fusion_a", FUSION * 16 * patches);
        let t_b = storage("fusion_b", FUSION * 16 * patches);
        let t_c = storage("fusion_c", FUSION * 16 * patches);
        let fused_buf = storage("fused", FUSION * 16 * patches);
        let big_floats = (FUSION * 64 * patches).max(HEAD_HIDDEN * height * width);
        let big_a = storage("big_a", big_floats);
        let big_b = storage("big_b", big_floats);
        let output = storage("disparity", height * width);
        let staging = gpu.readback("disparity_staging", bytes(height * width));

        let mut ops = Vec::new();
        let image = Map {
            buf: input.clone(),
            c: 3,
            h: height,
            w: width,
        };
        let (op, _) = self.conv(
            gpu,
            &image,
            "backbone.embeddings.patch_embeddings.projection.weight",
            DIM,
            PATCH,
            PATCH,
            0,
            BIAS,
            (None, None),
            &patch,
        );
        ops.push(op);
        ops.push(self.op(
            gpu,
            &self.kernels.embed,
            &[patches as u32, DIM as u32],
            &[
                (1, &patch),
                (2, self.w("backbone.embeddings.cls_token")),
                (3, &pos),
                (4, &h_a),
            ],
            [groups(DIM, 16), groups(tokens, 16), 1],
        ));

        let mut maps: Vec<Map> = Vec::new();
        for l in 0..LAYERS {
            let pre = format!("backbone.encoder.layer.{l}.");
            ops.push(self.layer_norm(gpu, &h_a, &format!("{pre}norm1"), tokens, &normed));
            ops.push(self.linear(
                gpu,
                &normed,
                &format!("{pre}qkv.weight"),
                tokens,
                3 * DIM,
                DIM,
                0,
                None,
                &qkv,
            ));
            ops.push(self.op(
                gpu,
                &self.kernels.attention,
                &[tokens as u32, HEADS as u32, (1.0f32 / 8.0).to_bits()],
                &[(1, &qkv), (2, &attended)],
                [groups(tokens, 64), HEADS as u32, 1],
            ));
            let ls1 = format!("{pre}layer_scale1.lambda1");
            ops.push(self.linear(
                gpu,
                &attended,
                &format!("{pre}attention.output.dense.weight"),
                tokens,
                DIM,
                DIM,
                2,
                Some((&ls1, &h_a)),
                &h_b,
            ));
            ops.push(self.layer_norm(gpu, &h_b, &format!("{pre}norm2"), tokens, &normed));
            ops.push(self.linear(
                gpu,
                &normed,
                &format!("{pre}mlp.fc1.weight"),
                tokens,
                MLP,
                DIM,
                1,
                None,
                &mlp,
            ));
            let ls2 = format!("{pre}layer_scale2.lambda1");
            ops.push(self.linear(
                gpu,
                &mlp,
                &format!("{pre}mlp.fc2.weight"),
                tokens,
                DIM,
                MLP,
                2,
                Some((&ls2, &h_b)),
                &h_a,
            ));

            let Some(k) = STAGES.iter().position(|&s| s == l) else {
                continue;
            };
            ops.push(self.layer_norm(gpu, &h_a, "backbone.layernorm", tokens, &normed));
            ops.push(self.op(
                gpu,
                &self.kernels.tokens_to_chw,
                &[patches as u32, DIM as u32],
                &[(1, &normed), (4, &chw)],
                [groups(patches, 16), groups(DIM, 16), 1],
            ));
            let tokens_map = Map {
                buf: chw.clone(),
                c: DIM,
                h: ph,
                w: pw,
            };
            let pre = format!("neck.reassemble_stage.layers.{k}.");
            let (op, proj) = self.conv(
                gpu,
                &tokens_map,
                &format!("{pre}projection.weight"),
                NECK[k],
                1,
                1,
                0,
                BIAS,
                (None, None),
                &projected,
            );
            ops.push(op);
            let reassembled = match k {
                0 | 1 => {
                    let factor = if k == 0 { 4 } else { 2 };
                    ops.push(self.op(
                        gpu,
                        &self.kernels.conv_transpose,
                        &[
                            NECK[k] as u32,
                            ph as u32,
                            pw as u32,
                            NECK[k] as u32,
                            factor as u32,
                        ],
                        &[
                            (1, &projected),
                            (2, self.w(&format!("{pre}resize.weight"))),
                            (3, self.w(&format!("{pre}resize.bias"))),
                            (4, &resized),
                        ],
                        [
                            groups(pw * factor, 8),
                            groups(ph * factor, 8),
                            NECK[k] as u32,
                        ],
                    ));
                    Map {
                        buf: resized.clone(),
                        c: NECK[k],
                        h: ph * factor,
                        w: pw * factor,
                    }
                }
                2 => proj,
                _ => {
                    let (op, map) = self.conv(
                        gpu,
                        &proj,
                        &format!("{pre}resize.weight"),
                        NECK[k],
                        3,
                        2,
                        1,
                        BIAS,
                        (None, None),
                        &resized,
                    );
                    ops.push(op);
                    map
                }
            };
            let (op, map) = self.conv(
                gpu,
                &reassembled,
                &format!("neck.convs.{k}.weight"),
                FUSION,
                3,
                1,
                1,
                0,
                (None, None),
                &features[k],
            );
            ops.push(op);
            maps.push(map);
        }

        // Fusion runs from the coarsest map to the finest.
        let mut fused: Option<Map> = None;
        for (i, k) in (0..4).rev().enumerate() {
            let pre = format!("neck.fusion_stage.layers.{i}.");
            let unit = |name: &str,
                        x: &Map,
                        extra: Option<&wgpu::Buffer>,
                        out: &wgpu::Buffer,
                        ops: &mut Vec<Op>| {
                let (op, mid) = self.conv(
                    gpu,
                    x,
                    &format!("{pre}{name}.convolution1.weight"),
                    FUSION,
                    3,
                    1,
                    1,
                    BIAS | RELU_IN,
                    (None, None),
                    &t_a,
                );
                ops.push(op);
                let (op, map) = self.conv(
                    gpu,
                    &mid,
                    &format!("{pre}{name}.convolution2.weight"),
                    FUSION,
                    3,
                    1,
                    1,
                    BIAS | RELU_IN,
                    (Some(&x.buf), extra),
                    out,
                );
                ops.push(op);
                map
            };
            let hidden = match &fused {
                None => maps[k].clone(),
                Some(previous) => unit(
                    "residual_layer1",
                    &maps[k],
                    Some(&previous.buf),
                    &t_b,
                    &mut ops,
                ),
            };
            let refined = unit("residual_layer2", &hidden, None, &t_c, &mut ops);
            let (h, w) = if k > 0 {
                (maps[k - 1].h, maps[k - 1].w)
            } else {
                (refined.h * 2, refined.w * 2)
            };
            let (op, up) = self.resize(gpu, &refined, h, w, &big_a);
            ops.push(op);
            let target = if k == 0 { &big_b } else { &fused_buf };
            let (op, map) = self.conv(
                gpu,
                &up,
                &format!("{pre}projection.weight"),
                FUSION,
                1,
                1,
                0,
                BIAS,
                (None, None),
                target,
            );
            ops.push(op);
            fused = Some(map);
        }

        let fused = fused.expect("four fusion layers");
        let (op, head) = self.conv(
            gpu,
            &fused,
            "head.conv1.weight",
            FUSION / 2,
            3,
            1,
            1,
            BIAS,
            (None, None),
            &big_a,
        );
        ops.push(op);
        let (op, head) = self.resize(gpu, &head, height, width, &big_b);
        ops.push(op);
        let (op, head) = self.conv(
            gpu,
            &head,
            "head.conv2.weight",
            HEAD_HIDDEN,
            3,
            1,
            1,
            BIAS | RELU_OUT,
            (None, None),
            &big_a,
        );
        ops.push(op);
        let (op, _) = self.conv(
            gpu,
            &head,
            "head.conv3.weight",
            1,
            1,
            1,
            0,
            BIAS | RELU_OUT,
            (None, None),
            &output,
        );
        ops.push(op);

        Plan {
            ops,
            input,
            output,
            staging,
            height,
            width,
        }
    }

    /// Uploads a normalized CHW image and queues the whole network.
    pub fn submit(&self, gpu: &Gpu, plan: &Plan, input: &[f32]) {
        assert_eq!(input.len(), 3 * plan.height * plan.width);
        gpu.queue
            .write_buffer(&plan.input, 0, bytemuck::cast_slice(input));
        let mut encoder = gpu
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("depth"),
            });
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("depth"),
                timestamp_writes: None,
            });
            for op in &plan.ops {
                pass.set_pipeline(&op.pipeline);
                pass.set_bind_group(0, &op.bind_group, &[]);
                pass.dispatch_workgroups(op.groups[0], op.groups[1], op.groups[2]);
            }
        }
        encoder.copy_buffer_to_buffer(&plan.output, 0, &plan.staging, 0, plan.staging.size());
        gpu.queue.submit([encoder.finish()]);
    }
}

impl Plan {
    /// Disparity at the model resolution, row-major `height × width`.
    pub async fn read(&self, gpu: &Gpu) -> Result<Vec<f32>, String> {
        Ok(to_f32(&read_buffer(gpu, &self.staging).await?))
    }
}

fn entry(gpu: &Gpu, name: &str) -> wgpu::ComputePipeline {
    let module = gpu
        .device
        .create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some(name),
            source: wgpu::ShaderSource::Wgsl(RESHAPE.into()),
        });
    gpu.device
        .create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some(name),
            layout: None,
            module: &module,
            entry_point: Some(name),
            compilation_options: Default::default(),
            cache: None,
        })
}

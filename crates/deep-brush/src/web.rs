//! Browser bindings. JavaScript owns input events, file decoding, and the
//! frame loop; this module owns the WebGPU device and everything drawn.

use std::cell::RefCell;
use std::rc::Rc;

use wasm_bindgen::prelude::*;
use web_sys::HtmlCanvasElement;

use crate::depth::DepthModel;
use crate::editor::{Editor, Layer, Mode, View};
use crate::gpu::Gpu;
use crate::mask::SmartMask;
use crate::preprocess;

struct State {
    surface: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
    editor: Editor,
    model: Option<DepthModel>,
}

#[wasm_bindgen]
pub struct DeepBrush {
    gpu: Rc<Gpu>,
    state: Rc<RefCell<State>>,
}

fn error(message: impl Into<String>) -> JsValue {
    js_sys::Error::new(&message.into()).into()
}

#[wasm_bindgen]
impl DeepBrush {
    /// Opens WebGPU on `canvas`. Fails where the browser has no WebGPU.
    pub async fn create(canvas: HtmlCanvasElement) -> Result<DeepBrush, JsValue> {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
            backends: wgpu::Backends::BROWSER_WEBGPU,
            ..wgpu::InstanceDescriptor::new_without_display_handle()
        });
        let (width, height) = (canvas.width().max(1), canvas.height().max(1));
        let surface = instance
            .create_surface(wgpu::SurfaceTarget::Canvas(canvas))
            .map_err(|e| error(format!("could not use the canvas: {e}")))?;
        let gpu = Gpu::new(&instance, Some(&surface)).await.map_err(error)?;
        let capabilities = surface.get_capabilities(&gpu.adapter);
        let format = capabilities
            .formats
            .iter()
            .copied()
            .find(|f| !f.is_srgb())
            .or_else(|| capabilities.formats.first().copied())
            .ok_or_else(|| error("the canvas offers no texture format"))?;
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            color_space: wgpu::SurfaceColorSpace::Auto,
            width,
            height,
            present_mode: wgpu::PresentMode::Fifo,
            desired_maximum_frame_latency: 2,
            alpha_mode: wgpu::CompositeAlphaMode::Opaque,
            view_formats: vec![],
        };
        surface.configure(&gpu.device, &config);
        let editor = Editor::new(&gpu);
        Ok(DeepBrush {
            gpu: Rc::new(gpu),
            state: Rc::new(RefCell::new(State {
                surface,
                config,
                editor,
                model: None,
            })),
        })
    }

    #[wasm_bindgen(getter)]
    pub fn adapter(&self) -> String {
        self.gpu.name.clone()
    }

    /// Parses a Depth Anything V2 Small safetensors file and uploads it.
    #[wasm_bindgen(js_name = loadModel)]
    pub fn load_model(&self, bytes: &js_sys::Uint8Array) -> Result<(), JsValue> {
        let read = |a: usize, b: usize| bytes.subarray(a as u32, b as u32).to_vec();
        let model = DepthModel::load(&self.gpu, bytes.length() as usize, &read).map_err(error)?;
        self.state.borrow_mut().model = Some(model);
        Ok(())
    }

    #[wasm_bindgen(getter, js_name = hasModel)]
    pub fn has_model(&self) -> bool {
        self.state.borrow().model.is_some()
    }

    /// Starts a new document from RGBA8 pixels.
    #[wasm_bindgen(js_name = setImage)]
    pub fn set_image(&self, rgba: &[u8], width: u32, height: u32) -> Result<(), JsValue> {
        if rgba.len() != (width * height * 4) as usize {
            return Err(error("pixel buffer does not match the image size"));
        }
        self.state
            .borrow_mut()
            .editor
            .load_image(&self.gpu, rgba, width as usize, height as usize);
        Ok(())
    }

    /// Runs the depth model on the current image; resolves with the model
    /// input size as `[width, height]`.
    #[wasm_bindgen(js_name = estimateDepth)]
    pub fn estimate_depth(&self) -> js_sys::Promise {
        let gpu = self.gpu.clone();
        let state = self.state.clone();
        wasm_bindgen_futures::future_to_promise(async move {
            // The borrow ends before the await, so input keeps working.
            let (plan, width, height) = {
                let s = state.borrow();
                let model = s
                    .model
                    .as_ref()
                    .ok_or_else(|| error("load the depth model first"))?;
                let (rgba, iw, ih) = s
                    .editor
                    .image()
                    .ok_or_else(|| error("load an image first"))?;
                let (h, w) = preprocess::model_size(iw, ih);
                let tensor = preprocess::image_tensor(rgba, iw, ih, h, w);
                let plan = model.plan(&gpu, h, w);
                model.submit(&gpu, &plan, &tensor);
                (plan, w, h)
            };
            let disparity = plan.read(&gpu).await.map_err(error)?;
            drop(plan);
            state
                .borrow_mut()
                .editor
                .set_depth(&gpu, &disparity, width, height);
            let size = js_sys::Array::of2(&(width as u32).into(), &(height as u32).into());
            Ok(size.into())
        })
    }

    #[allow(clippy::too_many_arguments)]
    #[wasm_bindgen(js_name = setBrush)]
    pub fn set_brush(
        &self,
        radius: f32,
        hardness: f32,
        opacity: f32,
        color: &[f32],
        mode: u32,
        light: bool,
        erase: bool,
    ) {
        let mut s = self.state.borrow_mut();
        let b = &mut s.editor.brush;
        b.radius = radius.max(1.0);
        b.hardness = hardness.clamp(0.0, 1.0);
        b.opacity = opacity.clamp(0.0, 1.0);
        if let [r, g, bl] = color {
            b.color = [*r, *g, *bl];
        }
        b.mode = match mode {
            0 => Mode::Flat,
            1 => Mode::Tilt,
            _ => Mode::Warp,
        };
        b.layer = if light { Layer::Light } else { Layer::Paint };
        b.erase = erase;
    }

    /// Smart mask: cue strengths in 0..=100, 0 turns a cue off, higher is
    /// stricter. `follow` re-samples the surface as the stroke moves instead
    /// of keeping the one under the first dab. Applies from the next stroke
    /// or decal placement.
    #[wasm_bindgen(js_name = setMask)]
    pub fn set_mask(&self, enabled: bool, depth: f32, normal: f32, color: f32, follow: bool) {
        self.state.borrow_mut().editor.mask = SmartMask {
            enabled,
            depth,
            normal,
            color,
            follow,
        };
    }

    #[wasm_bindgen(js_name = setLighting)]
    pub fn set_lighting(
        &self,
        azimuth: f32,
        elevation: f32,
        intensity: f32,
        ambient: f32,
        use_geometry: bool,
    ) {
        let mut s = self.state.borrow_mut();
        let l = &mut s.editor.lighting;
        l.azimuth = azimuth;
        l.elevation = elevation;
        l.intensity = intensity;
        l.ambient = ambient;
        l.use_geometry = use_geometry;
    }

    /// 0 result, 1 original, 2 depth, 3 normals, 4 shading, 5 albedo.
    #[wasm_bindgen(js_name = setView)]
    pub fn set_view(&self, view: u32) {
        self.state.borrow_mut().editor.view = match view {
            1 => View::Original,
            2 => View::Depth,
            3 => View::Normals,
            4 => View::Shading,
            5 => View::Albedo,
            _ => View::Result,
        };
    }

    #[wasm_bindgen(js_name = beginStroke)]
    pub fn begin_stroke(&self, x: f32, y: f32) {
        self.state.borrow_mut().editor.begin_stroke(&self.gpu, x, y);
    }

    #[wasm_bindgen(js_name = extendStroke)]
    pub fn extend_stroke(&self, x: f32, y: f32) {
        self.state
            .borrow_mut()
            .editor
            .extend_stroke(&self.gpu, x, y);
    }

    /// Commits the stroke, or the decal being placed.
    #[wasm_bindgen(js_name = endStroke)]
    pub fn end_stroke(&self) {
        self.state.borrow_mut().editor.end_stroke(&self.gpu);
    }

    #[wasm_bindgen(js_name = setDecal)]
    pub fn set_decal(&self, rgba: &[u8], width: u32, height: u32) -> Result<(), JsValue> {
        if rgba.len() != (width * height * 4) as usize || width == 0 || height == 0 {
            return Err(error("decal pixels do not match its size"));
        }
        self.state
            .borrow_mut()
            .editor
            .set_decal(&self.gpu, rgba, width as usize, height as usize);
        Ok(())
    }

    /// Previews the decal centred at `(x, y)`; `endStroke` applies it.
    #[wasm_bindgen(js_name = placeDecal)]
    pub fn place_decal(&self, x: f32, y: f32, half_width: f32, angle: f32) {
        self.state
            .borrow_mut()
            .editor
            .place_decal(&self.gpu, x, y, half_width, angle);
    }

    #[wasm_bindgen(js_name = cancelDecal)]
    pub fn cancel_decal(&self) {
        self.state.borrow_mut().editor.cancel_decal(&self.gpu);
    }

    pub fn undo(&self) -> bool {
        self.state.borrow_mut().editor.undo(&self.gpu)
    }

    #[wasm_bindgen(getter, js_name = canUndo)]
    pub fn can_undo(&self) -> bool {
        self.state.borrow().editor.can_undo()
    }

    /// Clears the paint layer, or the light layer when `light` is set.
    #[wasm_bindgen(js_name = clearLayer)]
    pub fn clear_layer(&self, light: bool) {
        let layer = if light { Layer::Light } else { Layer::Paint };
        self.state.borrow_mut().editor.clear_layer(&self.gpu, layer);
    }

    /// Resizes the canvas backing store.
    pub fn resize(&self, width: u32, height: u32) {
        let mut s = self.state.borrow_mut();
        s.config.width = width.max(1);
        s.config.height = height.max(1);
        let State {
            surface, config, ..
        } = &mut *s;
        surface.configure(&self.gpu.device, config);
    }

    /// Composites and presents one frame.
    pub fn frame(&self) -> Result<(), JsValue> {
        let mut s = self.state.borrow_mut();
        s.editor.render(&self.gpu);
        let frame = match s.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(frame)
            | wgpu::CurrentSurfaceTexture::Suboptimal(frame) => frame,
            other => {
                let State {
                    surface, config, ..
                } = &mut *s;
                surface.configure(&self.gpu.device, config);
                return Err(error(format!("canvas frame unavailable: {other:?}")));
            }
        };
        let view = frame.texture.create_view(&Default::default());
        let format = s.config.format;
        s.editor.present(&self.gpu, &view, format);
        self.gpu.queue.present(frame);
        Ok(())
    }

    /// Resolves with the full-resolution composite as RGBA8 pixels.
    pub fn export(&self) -> js_sys::Promise {
        let gpu = self.gpu.clone();
        let state = self.state.clone();
        wasm_bindgen_futures::future_to_promise(async move {
            let export = {
                let s = state.borrow();
                s.editor.render(&gpu);
                s.editor
                    .export(&gpu)
                    .ok_or_else(|| error("load an image first"))?
            };
            let pixels = export.read(&gpu).await.map_err(error)?;
            Ok(js_sys::Uint8Array::from(pixels.as_slice()).into())
        })
    }
}

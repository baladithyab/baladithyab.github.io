//! Audio-reactive energy ring rendered with WebGL2.
//!
//! JavaScript owns the frame loop and the audio graph. This crate owns
//! everything between an `AnalyserNode` and the pixels: spectrum analysis,
//! beat detection, spark simulation, and the draw calls.

mod analysis;
mod gl;
mod sparks;

use wasm_bindgen::prelude::*;
use web_sys::{
    AnalyserNode, HtmlCanvasElement, WebGl2RenderingContext as Gl, WebGlBuffer,
    WebGlContextAttributes, WebGlProgram, WebGlUniformLocation, WebGlVertexArrayObject,
};

use analysis::{Analysis, BANDS};
use sparks::Sparks;

const FULLSCREEN_VERT: &str = include_str!("shaders/fullscreen.vert");
const RING_FRAG: &str = concat!(
    include_str!("shaders/prelude.glsl"),
    include_str!("shaders/ring.frag")
);
const SPARK_VERT: &str = include_str!("shaders/spark.vert");
const SPARK_FRAG: &str = concat!(
    include_str!("shaders/prelude.glsl"),
    include_str!("shaders/spark.frag")
);

/// Ring radius at silence, in unit space (shorter canvas side spans -1..1).
const RADIUS: f32 = 0.5;
/// Height of a full-scale spectrum flare, in unit space.
const FLARE: f32 = 0.32;
/// Longest simulated step; a backgrounded tab resumes without a jump.
const MAX_STEP_SECS: f64 = 0.05;

#[wasm_bindgen]
pub struct EnergyRing {
    gl: Gl,
    analyser: Option<AnalyserNode>,
    /// Latest byte spectrum; empty until `connect`.
    freq: Vec<u8>,
    analysis: Analysis,
    sparks: Sparks,
    ring: RingPass,
    spark_pass: SparkPass,
    last_ms: f64,
    /// Animation clock in seconds; runs faster with louder audio.
    clock: f32,
    /// Fractional sparks owed by the continuous emitter.
    spark_debt: f32,
    calm: bool,
}

struct RingPass {
    program: WebGlProgram,
    vao: WebGlVertexArrayObject,
    resolution: Option<WebGlUniformLocation>,
    time: Option<WebGlUniformLocation>,
    radius: Option<WebGlUniformLocation>,
    levels: Option<WebGlUniformLocation>,
}

struct SparkPass {
    program: WebGlProgram,
    vao: WebGlVertexArrayObject,
    buffer: WebGlBuffer,
    scale: Option<WebGlUniformLocation>,
    point_size: Option<WebGlUniformLocation>,
    time: Option<WebGlUniformLocation>,
}

#[wasm_bindgen]
impl EnergyRing {
    /// Takes over `canvas` with a WebGL2 context. The ring idles until
    /// `connect` supplies audio.
    #[wasm_bindgen(constructor)]
    pub fn new(canvas: &HtmlCanvasElement) -> Result<EnergyRing, JsError> {
        let options = WebGlContextAttributes::new();
        options.set_alpha(false);
        options.set_antialias(false);
        options.set_depth(false);
        let gl = canvas
            .get_context_with_context_options("webgl2", &options)
            .ok()
            .flatten()
            .and_then(|context| context.dyn_into::<Gl>().ok())
            .ok_or_else(|| JsError::new("WebGL2 is not available"))?;

        let ring = RingPass::new(&gl)?;
        let spark_pass = SparkPass::new(&gl)?;
        // Sparks are the only blended draw; they add light on top of the ring.
        gl.blend_func(Gl::ONE, Gl::ONE);

        Ok(Self {
            gl,
            analyser: None,
            freq: Vec::new(),
            analysis: Analysis::new(),
            sparks: Sparks::new(),
            ring,
            spark_pass,
            last_ms: 0.0,
            clock: 0.0,
            spark_debt: 0.0,
            calm: false,
        })
    }

    /// Reads the spectrum from `analyser` on every following frame.
    pub fn connect(&mut self, analyser: AnalyserNode) {
        let bins = analyser.frequency_bin_count() as usize;
        self.freq.resize(bins, 0);
        self.analysis.set_bins(bins);
        self.analyser = Some(analyser);
    }

    /// Calm mode drops beat flashes and sparks (reduced-motion preference).
    #[wasm_bindgen(setter)]
    pub fn set_calm(&mut self, calm: bool) {
        self.calm = calm;
    }

    #[wasm_bindgen(getter)]
    pub fn bass(&self) -> f32 {
        self.analysis.bass
    }

    #[wasm_bindgen(getter)]
    pub fn mid(&self) -> f32 {
        self.analysis.mid
    }

    #[wasm_bindgen(getter)]
    pub fn treble(&self) -> f32 {
        self.analysis.treble
    }

    #[wasm_bindgen(getter)]
    pub fn beat(&self) -> f32 {
        self.analysis.beat
    }

    /// Advances the simulation to `now_ms` (a `requestAnimationFrame`
    /// timestamp) and draws at the canvas's current drawing-buffer size.
    pub fn frame(&mut self, now_ms: f64) -> Result<(), JsValue> {
        let dt = ((now_ms - self.last_ms) / 1000.0).clamp(0.0, MAX_STEP_SECS) as f32;
        self.last_ms = now_ms;

        if let Some(analyser) = &self.analyser {
            // The analyser writes straight into wasm memory; no copy.
            analyser.get_byte_frequency_data(&mut self.freq);
        }
        self.analysis.update(&self.freq, dt);

        let levels = &self.analysis;
        let energy = (levels.bass + levels.mid + levels.treble) / 3.0;
        let beat = if self.calm { 0.0 } else { levels.beat };
        let radius = RADIUS + 0.05 * levels.bass + 0.025 * beat;
        self.clock += dt * (0.35 + 1.4 * energy);

        self.sparks.step(dt);
        if !self.calm {
            self.spark_debt += dt * (30.0 * energy + 140.0 * levels.treble);
            let mut count = self.spark_debt as usize;
            self.spark_debt -= count as f32;
            if levels.onset {
                count += 30 + (90.0 * levels.bass) as usize;
            }
            self.sparks.emit(count, radius, FLARE, &levels.bands);
        }

        self.draw(radius, beat)
    }
}

impl EnergyRing {
    fn draw(&self, radius: f32, beat: f32) -> Result<(), JsValue> {
        let gl = &self.gl;
        let levels = &self.analysis;
        let width = gl.drawing_buffer_width();
        let height = gl.drawing_buffer_height();
        let short_side = width.min(height) as f32;
        gl.viewport(0, 0, width, height);

        // A light blur keeps neighbouring bands from forming hard-edged wedges.
        let bands = &levels.bands;
        let spectrum: [u8; BANDS] = core::array::from_fn(|k| {
            let below = bands[k.saturating_sub(1)];
            let above = bands[(k + 1).min(BANDS - 1)];
            (255.0 * (0.25 * below + 0.5 * bands[k] + 0.25 * above)) as u8
        });
        gl.disable(Gl::BLEND);
        gl.use_program(Some(&self.ring.program));
        gl.bind_vertex_array(Some(&self.ring.vao));
        gl.tex_sub_image_2d_with_i32_and_i32_and_u32_and_type_and_opt_u8_array(
            Gl::TEXTURE_2D,
            0,
            0,
            0,
            BANDS as i32,
            1,
            Gl::RED,
            Gl::UNSIGNED_BYTE,
            Some(&spectrum),
        )?;
        gl.uniform2f(self.ring.resolution.as_ref(), width as f32, height as f32);
        gl.uniform1f(self.ring.time.as_ref(), self.clock);
        gl.uniform1f(self.ring.radius.as_ref(), radius);
        gl.uniform4f(
            self.ring.levels.as_ref(),
            levels.bass,
            levels.mid,
            levels.treble,
            beat,
        );
        gl.draw_arrays(Gl::TRIANGLES, 0, 3);

        let vertices = self.sparks.vertices();
        if !vertices.is_empty() {
            gl.enable(Gl::BLEND);
            gl.use_program(Some(&self.spark_pass.program));
            gl.bind_vertex_array(Some(&self.spark_pass.vao));
            gl.bind_buffer(Gl::ARRAY_BUFFER, Some(&self.spark_pass.buffer));
            gl.buffer_sub_data_with_i32_and_u8_array(Gl::ARRAY_BUFFER, 0, bytes(vertices));
            gl.uniform2f(
                self.spark_pass.scale.as_ref(),
                short_side / width as f32,
                short_side / height as f32,
            );
            gl.uniform1f(self.spark_pass.point_size.as_ref(), 0.014 * short_side);
            gl.uniform1f(self.spark_pass.time.as_ref(), self.clock);
            gl.draw_arrays(
                Gl::POINTS,
                0,
                (vertices.len() / sparks::FLOATS_PER_SPARK) as i32,
            );
        }
        Ok(())
    }
}

impl RingPass {
    fn new(gl: &Gl) -> Result<Self, JsError> {
        let program = gl::program(gl, FULLSCREEN_VERT, RING_FRAG)?;
        let vao = gl
            .create_vertex_array()
            .ok_or_else(|| JsError::new("WebGL could not create a vertex array"))?;

        // The spectrum texture is the context's only texture: it stays bound
        // to unit 0, which is also the sampler uniform's default.
        let texture = gl
            .create_texture()
            .ok_or_else(|| JsError::new("WebGL could not create a texture"))?;
        gl.bind_texture(Gl::TEXTURE_2D, Some(&texture));
        gl.tex_storage_2d(Gl::TEXTURE_2D, 1, Gl::R8, BANDS as i32, 1);
        gl.tex_parameteri(Gl::TEXTURE_2D, Gl::TEXTURE_MIN_FILTER, Gl::LINEAR as i32);
        gl.tex_parameteri(Gl::TEXTURE_2D, Gl::TEXTURE_MAG_FILTER, Gl::LINEAR as i32);
        gl.tex_parameteri(Gl::TEXTURE_2D, Gl::TEXTURE_WRAP_S, Gl::CLAMP_TO_EDGE as i32);
        gl.tex_parameteri(Gl::TEXTURE_2D, Gl::TEXTURE_WRAP_T, Gl::CLAMP_TO_EDGE as i32);

        gl.use_program(Some(&program));
        gl.uniform1f(gl.get_uniform_location(&program, "uFlare").as_ref(), FLARE);

        Ok(Self {
            resolution: gl.get_uniform_location(&program, "uResolution"),
            time: gl.get_uniform_location(&program, "uTime"),
            radius: gl.get_uniform_location(&program, "uRadius"),
            levels: gl.get_uniform_location(&program, "uLevels"),
            program,
            vao,
        })
    }
}

impl SparkPass {
    fn new(gl: &Gl) -> Result<Self, JsError> {
        let program = gl::program(gl, SPARK_VERT, SPARK_FRAG)?;
        let vao = gl
            .create_vertex_array()
            .ok_or_else(|| JsError::new("WebGL could not create a vertex array"))?;
        let buffer = gl
            .create_buffer()
            .ok_or_else(|| JsError::new("WebGL could not create a buffer"))?;

        let floats = sparks::FLOATS_PER_SPARK as i32;
        let capacity_bytes = sparks::CAPACITY as i32 * floats * size_of::<f32>() as i32;
        gl.bind_vertex_array(Some(&vao));
        gl.bind_buffer(Gl::ARRAY_BUFFER, Some(&buffer));
        gl.buffer_data_with_i32(Gl::ARRAY_BUFFER, capacity_bytes, Gl::DYNAMIC_DRAW);
        gl.enable_vertex_attrib_array(0);
        gl.vertex_attrib_pointer_with_i32(0, floats, Gl::FLOAT, false, 0, 0);

        Ok(Self {
            scale: gl.get_uniform_location(&program, "uScale"),
            point_size: gl.get_uniform_location(&program, "uPointSize"),
            time: gl.get_uniform_location(&program, "uTime"),
            program,
            vao,
            buffer,
        })
    }
}

fn bytes(floats: &[f32]) -> &[u8] {
    // SAFETY: `f32` has no padding and every byte pattern is a valid `u8`;
    // the result covers exactly the input's memory for the same lifetime.
    unsafe { core::slice::from_raw_parts(floats.as_ptr().cast(), size_of_val(floats)) }
}

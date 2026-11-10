//! Audio-reactive energy ring rendered with WebGL2.
//!
//! JavaScript owns the frame loop and the audio graph. This crate owns
//! everything between an `AnalyserNode` and the pixels: spectrum analysis,
//! beat detection, the ring's 3D geometry and its projection, spark
//! simulation, and the draw calls.

mod analysis;
mod camera;
mod gl;
mod ring;
mod sparks;

use core::f32::consts::TAU;

use wasm_bindgen::prelude::*;
use web_sys::{
    AnalyserNode, HtmlCanvasElement, WebGl2RenderingContext as Gl, WebGlContextAttributes,
    WebGlProgram, WebGlUniformLocation,
};

use analysis::Analysis;
use camera::Camera;
use ring::{Shape, Vertex};
use sparks::Sparks;

const STRIP_VERT: &str = include_str!("shaders/strip.vert");
const CURTAIN_FRAG: &str = concat!(
    include_str!("shaders/prelude.glsl"),
    include_str!("shaders/curtain.frag")
);
const RIBBON_FRAG: &str = concat!(
    include_str!("shaders/prelude.glsl"),
    include_str!("shaders/ribbon.frag")
);
const SPARK_VERT: &str = include_str!("shaders/spark.vert");
const SPARK_FRAG: &str = concat!(
    include_str!("shaders/prelude.glsl"),
    include_str!("shaders/spark.frag")
);

/// Vertices in the ring's strips; sparks follow them in the buffer.
const RING_VERTICES: usize = ring::STRIPS * ring::STRIP_VERTICES;
/// Longest simulated step; a backgrounded tab resumes without a jump.
const MAX_STEP_SECS: f64 = 0.05;

#[wasm_bindgen]
pub struct EnergyRing {
    gl: Gl,
    analyser: Option<AnalyserNode>,
    /// Latest byte spectrum; empty until `connect`.
    freq: Vec<u8>,
    analysis: Analysis,
    camera: Camera,
    sparks: Sparks,
    /// This frame's geometry: the ring's strips, then one point per spark.
    vertices: Vec<Vertex>,
    curtain: Pass,
    ribbons: Pass,
    spark_points: Pass,
    spark_size: Option<WebGlUniformLocation>,
    last_ms: f64,
    /// Animation clock in seconds; runs faster with louder audio.
    clock: f32,
    /// Rotation of the ring about its own axis, in radians.
    spin: f32,
    /// Fractional sparks owed by the continuous emitter.
    spark_debt: f32,
    calm: bool,
}

/// A shader program and the uniforms every pass shares.
struct Pass {
    program: WebGlProgram,
    scale: Option<WebGlUniformLocation>,
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

        let curtain = Pass::new(&gl, STRIP_VERT, CURTAIN_FRAG)?;
        let ribbons = Pass::new(&gl, STRIP_VERT, RIBBON_FRAG)?;
        let spark_points = Pass::new(&gl, SPARK_VERT, SPARK_FRAG)?;
        let spark_size = gl.get_uniform_location(&spark_points.program, "uPointSize");

        // Everything is light on a dark background: each draw adds.
        gl.enable(Gl::BLEND);
        gl.blend_func(Gl::ONE, Gl::ONE);
        gl.clear_color(0.010, 0.012, 0.030, 1.0);

        // One vertex array and one buffer serve every pass. They stay bound
        // for the context's lifetime, which also keeps them alive.
        let vertex_array = gl
            .create_vertex_array()
            .ok_or_else(|| JsError::new("WebGL could not create a vertex array"))?;
        let buffer = gl
            .create_buffer()
            .ok_or_else(|| JsError::new("WebGL could not create a buffer"))?;
        let capacity = RING_VERTICES + sparks::CAPACITY;
        let stride = size_of::<Vertex>() as i32;
        gl.bind_vertex_array(Some(&vertex_array));
        gl.bind_buffer(Gl::ARRAY_BUFFER, Some(&buffer));
        gl.buffer_data_with_i32(Gl::ARRAY_BUFFER, capacity as i32 * stride, Gl::DYNAMIC_DRAW);
        gl.enable_vertex_attrib_array(0);
        gl.vertex_attrib_pointer_with_i32(0, 2, Gl::FLOAT, false, stride, 0);
        gl.enable_vertex_attrib_array(1);
        gl.vertex_attrib_pointer_with_i32(1, 4, Gl::FLOAT, false, stride, 8);

        Ok(Self {
            gl,
            analyser: None,
            freq: Vec::new(),
            analysis: Analysis::new(),
            camera: Camera::new(),
            sparks: Sparks::new(),
            vertices: Vec::with_capacity(capacity),
            curtain,
            ribbons,
            spark_points,
            spark_size,
            last_ms: 0.0,
            clock: 0.0,
            spin: 0.0,
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

    /// Calm mode drops beat flashes, sparks, and the ring's spin
    /// (reduced-motion preference).
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
    pub fn frame(&mut self, now_ms: f64) {
        let dt = ((now_ms - self.last_ms) / 1000.0).clamp(0.0, MAX_STEP_SECS) as f32;
        self.last_ms = now_ms;

        if let Some(analyser) = &self.analyser {
            // The analyser writes straight into wasm memory; no copy.
            analyser.get_byte_frequency_data(&mut self.freq);
        }
        self.analysis.update(&self.freq, dt);

        let levels = &self.analysis;
        let bands = levels.blurred();
        let energy = (levels.bass + levels.mid + levels.treble) / 3.0;
        let beat = if self.calm { 0.0 } else { levels.beat };
        let radius = 1.0 + 0.06 * levels.bass + 0.03 * beat;
        self.clock += dt * (0.35 + 1.4 * energy);

        self.sparks.step(dt);
        if !self.calm {
            self.spin = (self.spin + dt * (0.15 + 0.6 * energy)) % TAU;
            self.spark_debt += dt * (30.0 * energy + 140.0 * levels.treble);
            let mut count = self.spark_debt as usize;
            self.spark_debt -= count as f32;
            if levels.onset {
                count += 30 + (90.0 * levels.bass) as usize;
            }
            self.sparks
                .emit(count, radius, self.spin, ring::HEIGHT, &bands);
        }

        self.vertices.clear();
        ring::build(
            &mut self.vertices,
            &self.camera,
            &Shape {
                bands: &bands,
                radius,
                spin: self.spin,
                clock: self.clock,
                energy,
                flash: 1.0 + 0.8 * beat,
            },
        );
        self.sparks.write(&self.camera, &mut self.vertices);
        self.draw();
    }
}

impl EnergyRing {
    fn draw(&self) {
        let gl = &self.gl;
        let width = gl.drawing_buffer_width();
        let height = gl.drawing_buffer_height();
        let short_side = width.min(height) as f32;
        let scale = (short_side / width as f32, short_side / height as f32);
        gl.viewport(0, 0, width, height);
        gl.clear(Gl::COLOR_BUFFER_BIT);
        gl.buffer_sub_data_with_i32_and_u8_array(
            Gl::ARRAY_BUFFER,
            0,
            bytes(self.vertices.as_flattened()),
        );

        let strip = ring::STRIP_VERTICES as i32;
        self.curtain.activate(gl, scale, self.clock);
        gl.draw_arrays(Gl::TRIANGLE_STRIP, 0, strip);

        self.ribbons.activate(gl, scale, self.clock);
        for ribbon in 1..ring::STRIPS as i32 {
            gl.draw_arrays(Gl::TRIANGLE_STRIP, ribbon * strip, strip);
        }

        let spark_count = self.vertices.len() - RING_VERTICES;
        if spark_count > 0 {
            self.spark_points.activate(gl, scale, self.clock);
            gl.uniform1f(self.spark_size.as_ref(), 0.014 * short_side);
            gl.draw_arrays(Gl::POINTS, RING_VERTICES as i32, spark_count as i32);
        }
    }
}

impl Pass {
    fn new(gl: &Gl, vertex: &str, fragment: &str) -> Result<Self, JsError> {
        let program = gl::program(gl, vertex, fragment)?;
        Ok(Self {
            scale: gl.get_uniform_location(&program, "uScale"),
            time: gl.get_uniform_location(&program, "uTime"),
            program,
        })
    }

    fn activate(&self, gl: &Gl, scale: (f32, f32), time: f32) {
        gl.use_program(Some(&self.program));
        gl.uniform2f(self.scale.as_ref(), scale.0, scale.1);
        gl.uniform1f(self.time.as_ref(), time);
    }
}

fn bytes(floats: &[f32]) -> &[u8] {
    // SAFETY: `f32` has no padding and every byte pattern is a valid `u8`;
    // the result covers exactly the input's memory for the same lifetime.
    unsafe { core::slice::from_raw_parts(floats.as_ptr().cast(), size_of_val(floats)) }
}

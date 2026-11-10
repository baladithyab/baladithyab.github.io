//! Shader compilation helpers.

use wasm_bindgen::JsError;
use web_sys::{WebGl2RenderingContext as Gl, WebGlProgram, WebGlShader};

pub fn program(gl: &Gl, vertex: &str, fragment: &str) -> Result<WebGlProgram, JsError> {
    let program = gl
        .create_program()
        .ok_or_else(|| JsError::new("WebGL could not create a program"))?;
    gl.attach_shader(&program, &shader(gl, Gl::VERTEX_SHADER, vertex)?);
    gl.attach_shader(&program, &shader(gl, Gl::FRAGMENT_SHADER, fragment)?);
    gl.link_program(&program);

    if gl
        .get_program_parameter(&program, Gl::LINK_STATUS)
        .is_truthy()
    {
        Ok(program)
    } else {
        let log = gl.get_program_info_log(&program).unwrap_or_default();
        Err(JsError::new(&format!("shader link failed: {log}")))
    }
}

fn shader(gl: &Gl, kind: u32, source: &str) -> Result<WebGlShader, JsError> {
    let shader = gl
        .create_shader(kind)
        .ok_or_else(|| JsError::new("WebGL could not create a shader"))?;
    gl.shader_source(&shader, source);
    gl.compile_shader(&shader);

    if gl
        .get_shader_parameter(&shader, Gl::COMPILE_STATUS)
        .is_truthy()
    {
        Ok(shader)
    } else {
        let log = gl.get_shader_info_log(&shader).unwrap_or_default();
        Err(JsError::new(&format!("shader compile failed: {log}")))
    }
}

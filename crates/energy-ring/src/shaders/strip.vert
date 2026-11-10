#version 300 es

// Unit space: the shorter canvas side spans -1..1. Rust has already
// projected the 3D scene.
layout(location = 0) in vec2 aPosition;
layout(location = 1) in vec4 aParams;

// Unit space to clip space.
uniform vec2 uScale;

out vec4 vParams;

void main() {
  vParams = aParams;
  gl_Position = vec4(aPosition * uScale, 0.0, 1.0);
}

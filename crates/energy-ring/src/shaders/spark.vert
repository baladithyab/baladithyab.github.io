#version 300 es

layout(location = 0) in vec2 aPosition;
// remaining life (1 → 0), ring coordinate at birth, perspective scale, unused
layout(location = 1) in vec4 aParams;

// Unit space to clip space.
uniform vec2 uScale;
// Diameter in pixels of a newborn spark at the ring centre's depth.
uniform float uPointSize;

out vec4 vParams;

void main() {
  vParams = aParams;
  gl_Position = vec4(aPosition * uScale, 0.0, 1.0);
  gl_PointSize = uPointSize * aParams.z * (0.35 + 0.65 * aParams.x);
}

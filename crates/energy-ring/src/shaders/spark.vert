#version 300 es

// x, y, remaining life (1 → 0), ring coordinate at birth
layout(location = 0) in vec4 aSpark;

// Unit space (shorter canvas side spans -1..1) to clip space.
uniform vec2 uScale;
// Diameter of a newborn spark in pixels.
uniform float uPointSize;

out float vLife;
out float vHue;

void main() {
  vLife = aSpark.z;
  vHue = aSpark.w;
  gl_Position = vec4(aSpark.xy * uScale, 0.0, 1.0);
  gl_PointSize = uPointSize * (0.35 + 0.65 * aSpark.z);
}

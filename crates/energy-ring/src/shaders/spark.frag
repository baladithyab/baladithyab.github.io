// Appended to prelude.glsl.

uniform float uTime;

in float vLife;
// Ring coordinate the spark was born at.
in float vHue;
out vec4 outColor;

void main() {
  vec2 point = gl_PointCoord * 2.0 - 1.0;
  float glow = max(0.0, 1.0 - dot(point, point));
  glow *= glow;
  // Tinted halo with a white-hot centre; blended additively.
  outColor = vec4((ringTint(vHue, uTime) * 1.4 + 0.6 * glow) * glow * vLife, 1.0);
}

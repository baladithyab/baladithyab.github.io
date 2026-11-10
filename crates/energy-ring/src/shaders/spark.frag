// Appended to prelude.glsl.

uniform float uTime;

// remaining life (1 → 0), ring coordinate at birth, perspective scale, unused
in vec4 vParams;

out vec4 outColor;

void main() {
  vec2 point = gl_PointCoord * 2.0 - 1.0;
  float glow = max(0.0, 1.0 - dot(point, point));
  glow *= glow;
  // Tinted halo with a white-hot centre; blended additively.
  outColor = vec4((ringTint(vParams.y, uTime) * 1.4 + 0.6 * glow) * glow * vParams.x, 1.0);
}

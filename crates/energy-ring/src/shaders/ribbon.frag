// Appended to prelude.glsl.

uniform float uTime;

// across the ribbon (-1..1), ring coordinate, gain, softness (0 line, 1 haze)
in vec4 vParams;

out vec4 outColor;

void main() {
  float away = abs(vParams.x);
  float edge = 1.0 - away;
  // A sharp core with a long skirt, or a broad haze; both reach zero at the
  // ribbon's edge so the strip's outline never shows.
  float line = 0.08 / (away + 0.08) * edge;
  float haze = edge * edge * edge;
  float glow = mix(line, haze, vParams.w);
  float whiteHot = line * line * line * (1.0 - vParams.w);

  // Blended additively.
  outColor = vec4((ringTint(vParams.y, uTime) * glow + 0.7 * whiteHot) * vParams.z, 1.0);
}

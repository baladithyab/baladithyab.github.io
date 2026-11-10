// Appended to prelude.glsl.

uniform float uTime;

// height (0 rest circle → 1 crest), ring coordinate, band level, gain
in vec4 vParams;

out vec4 outColor;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 cell = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(cell), hash(cell + vec2(1.0, 0.0)), u.x),
    mix(hash(cell + vec2(0.0, 1.0)), hash(cell + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

void main() {
  float height = vParams.x;
  // Soft streaks that climb from the rest circle toward the crest.
  vec2 p = vec2(18.0 * vParams.y, 2.0 * height - 1.2 * uTime);
  float streaks = 0.65 * noise(p) + 0.35 * noise(2.1 * p + 17.1);
  // Brightest just under the crest, fading toward the ring's plane.
  float body = (0.1 + 1.4 * height * height) * (0.7 + 0.6 * streaks);

  // Blended additively.
  outColor = vec4(ringTint(vParams.y, uTime) * body * vParams.z * vParams.w, 1.0);
}

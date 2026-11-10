// Appended to prelude.glsl.

uniform vec2 uResolution;
uniform float uTime;
uniform float uRadius;
// Height of a full-scale spectrum flare, in the same units as uRadius.
uniform float uFlare;
// bass, mid, treble, beat
uniform vec4 uLevels;
// BANDS x 1, bass at u = 0.
uniform sampler2D uSpectrum;

out vec4 outColor;

const float PI = 3.14159265359;

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

float fbm(vec2 p) {
  float sum = 0.0;
  float amplitude = 0.5;
  for (int i = 0; i < 4; i++) {
    sum += amplitude * noise(p);
    p = p * 2.03 + 17.1;
    amplitude *= 0.5;
  }
  return sum;
}

void main() {
  // Unit space: the shorter canvas side spans -1..1.
  vec2 p = (2.0 * gl_FragCoord.xy - uResolution) / min(uResolution.x, uResolution.y);
  float r = length(p);
  vec2 direction = p / max(r, 1e-4);

  // Angle from the top, mirrored left/right: bass at 12 o'clock, treble at 6.
  float u = abs(atan(p.x, p.y)) / PI;
  float level = texture(uSpectrum, vec2(u, 0.5)).r;

  float bass = uLevels.x;
  float beat = uLevels.w;
  float energy = (uLevels.x + uLevels.y + uLevels.z) / 3.0;

  float outside = r - uRadius;
  // Near the centre an angular gradient pinches into wedges; settle on one
  // colour there.
  vec3 tint = mix(ringTint(0.5, uTime), ringTint(u, uTime), smoothstep(0.0, 0.6 * uRadius, r));
  vec3 color = vec3(0.0);

  // Three noisy filaments hugging the ring. Sampling noise along the
  // direction vector instead of the angle avoids a seam at 6 o'clock.
  float wobble = 0.012 + 0.05 * energy + 0.04 * level;
  for (int i = 0; i < 3; i++) {
    float layer = float(i);
    vec2 q = direction * (2.5 + layer) + vec2(uTime * (0.5 + 0.2 * layer), 7.3 * layer);
    float shift = (fbm(q) - 0.47) * wobble * (1.0 + layer);
    float gap = abs(outside - shift);
    float glow = (0.0035 + 0.003 * level) / (gap + 0.0015) * exp(-6.0 * gap);
    color += tint * glow * (1.0 - 0.25 * layer);
  }

  // Spectrum flares rising outward from the ring.
  float reach = clamp(1.0 - outside / max(uFlare * level, 1e-3), 0.0, 1.0) * step(0.0, outside);
  float flame = fbm(vec2(24.0 * u, 9.0 * outside - 2.5 * uTime));
  color += tint * reach * reach * (0.35 + 1.3 * flame) * level * 1.6;

  // Halo that falls off faster inside the ring, and a core pulse on beats.
  float halo = exp(-(outside > 0.0 ? 5.0 : 12.0) * abs(outside));
  color += tint * halo * (0.06 + 0.24 * energy + 0.2 * bass);
  color += ringTint(0.5, uTime) * exp(-9.0 * r * r) * (0.03 + 0.35 * beat * bass);

  color *= 1.0 + 0.8 * beat;
  color += vec3(0.010, 0.012, 0.030) * (1.0 - 0.5 * r);

  outColor = vec4(1.0 - exp(-1.3 * color), 1.0);
}

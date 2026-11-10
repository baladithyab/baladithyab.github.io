#version 300 es
precision highp float;

// Cyan → violet → magenta and back. Eased so the gradient has no visible
// kink where it turns around.
vec3 palette(float t) {
  t = abs(fract(t) * 2.0 - 1.0);
  vec3 cyan = vec3(0.10, 0.85, 1.00);
  vec3 violet = vec3(0.55, 0.30, 1.00);
  vec3 magenta = vec3(1.00, 0.25, 0.70);
  return mix(mix(cyan, violet, smoothstep(0.0, 0.6, t)), magenta, smoothstep(0.4, 1.0, t));
}

// Colour at ring coordinate u (0 at the top, 1 at the bottom). Flat at both
// ends, where the mirrored halves of the ring meet.
vec3 ringTint(float u, float time) {
  return palette(0.8 * u * u * (3.0 - 2.0 * u) + 0.04 * time);
}

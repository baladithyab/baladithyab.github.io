/**
 * Vitest configuration — runs unit tests for src/lib/* helpers.
 *
 * Tests live alongside source as `*.test.ts`. Astro/JSX compilation is
 * irrelevant here — we only test pure TS modules under src/lib/, so we don't
 * need the @astrojs/vitest preset.
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    globals: false,
    coverage: {
      provider: 'v8',
      include: ['src/lib/**/*.ts'],
      exclude: ['src/lib/**/*.test.ts'],
      reporter: ['text', 'html', 'json-summary'],
    },
  },
})

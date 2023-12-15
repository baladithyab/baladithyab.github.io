import { defineConfig } from 'astro/config'
import cloudflare from '@astrojs/cloudflare';
import react from '@astrojs/react'
import tailwind from '@astrojs/tailwind'
import path from 'path';

// https://astro.build/config
export default defineConfig({
  output: 'server',
  adapter: cloudflare({
    runtime: {
      mode: 'local',
      type: 'pages',
    }
  }),
  integrations: [
    react(),
    tailwind({
      applyBaseStyles: false,
    }),
  ],
  resolve: {
    alias: {
      "@/*": path.resolve(__dirname, "./src"),
    }
  }
})

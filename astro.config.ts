import { defineConfig } from 'astro/config'
import cloudflare from '@astrojs/cloudflare';
import react from '@astrojs/react'
import tailwind from '@astrojs/tailwind'

// https://astro.build/config
export default defineConfig({
  output: 'server',
  adapter: cloudflare({
    runtime: {
      mode: 'local',
      type: 'pages',
    }
  }),
  // adapter: cloudflare({ mode: "directory" }),
  integrations: [
    react(),
    tailwind({
      applyBaseStyles: false,
    }),
  ],
})

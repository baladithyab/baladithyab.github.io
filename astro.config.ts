import { defineConfig } from 'astro/config'
import cloudflare from '@astrojs/cloudflare'
import react from '@astrojs/react'
import tailwind from '@astrojs/tailwind'
import sentry from '@sentry/astro'
import spotlightjs from '@spotlightjs/astro'
import auth from 'auth-astro'
import compress from 'astro-compress'
const isDev = import.meta.env.DEV
const devInteg = isDev ? [sentry(), spotlightjs()] : []

// https://astro.build/config
export default defineConfig({
  output: 'server',
  site: 'https://codeseys.io/',
  adapter: cloudflare({
    mode: 'directory',
  }),
  // pages functions
  integrations: [
    ...devInteg,
    react(),
    tailwind({
      applyBaseStyles: false,
      
    }),
    auth(),
    compress(),
  ],
})

// adapter: cloudflare({  // just pages
//   runtime: {
//     mode: 'local',
//     type: 'pages',
//   }
// }),

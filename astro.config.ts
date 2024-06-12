import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import react from '@astrojs/react';
import tailwind from '@astrojs/tailwind';
import sentry from '@sentry/astro';
import spotlightjs from '@spotlightjs/astro';
import auth from 'auth-astro';
import pageInsight from "astro-page-insight";
import Icons from 'unplugin-icons/vite'
// import partytown from "@astrojs/partytown";
const devInteg = import.meta.env.IS_DEV ? [sentry(), spotlightjs(), pageInsight()] : [];


// https://astro.build/config
export default defineConfig({
  // output: 'hybrid',
  output: 'server',
  site: 'https://codeseys.io/',
  adapter: cloudflare({
    // mode: 'directory',
    platformProxy: {
      enabled: true
    },
  }),
  // pages functions
  integrations: [
    ...devInteg,
    react({
      // experimentalReactChildren: true,
    }),
    tailwind({
      applyBaseStyles: false
    }),
    auth(),
    // compress(),
    // partytown()
  ],
  vite: {
    ssr: {
      external: ["node:path"],
    },
    plugins: [
      Icons({
        compiler: 'astro',
      }),
    ],
    // build: {
    //   rollupOptions: {
    //     external: [
    //       'node:path',
    //     ]
    //   }
    // }
  }
});
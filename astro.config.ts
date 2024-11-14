import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import react from '@astrojs/react';
import tailwind from '@astrojs/tailwind';
import sentry from '@sentry/astro';
import auth from 'auth-astro';
import sitemap from '@astrojs/sitemap';
import prefetch from '@astrojs/prefetch';
import robotsTxt from 'astro-robots-txt';
import image from '@astrojs/image';
import compress from 'astro-compress';
import mdx from '@astrojs/mdx';
import Icons from 'unplugin-icons/vite';

const devInteg = import.meta.env.IS_DEV ? [sentry(), spotlightjs(), pageInsight()] : [];

// https://astro.build/config
export default defineConfig({
  output: 'server',
  site: 'https://codeseys.io/',
  adapter: cloudflare({
    platformProxy: {
      enabled: true
    },
  }),
  integrations: [
    ...devInteg,
    react(),
    tailwind({
      applyBaseStyles: false
    }),
    auth(),
    sitemap(),
    prefetch(),
    robotsTxt(),
    image({
      serviceEntryPoint: '@astrojs/image/sharp',
      cacheDir: './.cache/image',
      logLevel: 'debug'
    }),
    compress({
      css: true,
      html: true,
      img: true,
      js: true,
      svg: true
    }),
    mdx()
  ],
  vite: {
    ssr: {
      external: ["node:path"],
    },
    plugins: [
      Icons({
        compiler: 'astro',
        autoInstall: true,
      }),
    ],
    build: {
      target: 'esnext',
      minify: 'esbuild',
      cssMinify: true,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('node_modules')) {
              if (id.includes('@notionhq/client')) return 'notion';
              if (id.includes('react')) return 'react-vendor';
              if (id.includes('@radix-ui')) return 'ui';
            }
          }
        }
      }
    },
    optimizeDeps: {
      include: ['react', 'react-dom'],
      exclude: ['@astrojs/cloudflare']
    }
  },
  prefetch: {
    prefetchAll: true,
    defaultStrategy: 'hover'
  }
});

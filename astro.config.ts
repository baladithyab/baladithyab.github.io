import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import react from '@astrojs/react';
import tailwind from '@astrojs/tailwind';
import pageInsight from 'astro-page-insight';
import Icons from 'unplugin-icons/vite';

// Dev-only integrations
const devIntegrations = import.meta.env.DEV ? [pageInsight()] : [];

// https://astro.build/config
export default defineConfig({
  output: 'server',
  site: 'https://codeseys.io/',
  adapter: cloudflare({
    platformProxy: {
      enabled: true,
    },
  }),
  integrations: [
    ...devIntegrations,
    react(),
    tailwind({
      applyBaseStyles: false,
    }),
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
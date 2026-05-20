import { defineConfig, sessionDrivers } from 'astro/config'
import cloudflare from '@astrojs/cloudflare'
import mdx from '@astrojs/mdx'
import react from '@astrojs/react'
import Icons from 'unplugin-icons/vite'
import tailwindcss from '@tailwindcss/vite'

// https://astro.build/config
export default defineConfig({
  output: 'server',
  site: 'https://codeseys.io/',
  adapter: cloudflare({
    // Explicitly set to avoid sharp runtime warnings and keep builds predictable on Pages/Workers.
    imageService: 'compile',
  }),
  // @astrojs/cloudflare will otherwise auto-enable sessions backed by a KV binding named "SESSION".
  // We don't use Astro sessions yet, so keep this in-memory to avoid requiring KV config.
  session: {
    driver: sessionDrivers.lruCache({
      max: 500,
    }),
  },
  integrations: [mdx(), react()],
  vite: {
    ssr: {
      external: ['node:path'],
    },
    // Note: @astrojs/cloudflare configures SSR aliasing/conditions for workerd during build.
    plugins: [
      tailwindcss(),
      Icons({
        compiler: 'astro',
        autoInstall: true,
      }),
      {
        // Workaround for https://github.com/withastro/astro/issues/16248
        // Pre-bundle SSR deps that workerd's CustomModuleRunner can't discover at runtime.
        // Without this, the first request crashes with "Astro is not defined" / "module is not defined"
        // because deps cascade through program reloads and chunk references go stale.
        // The Cloudflare adapter seeds Astro internals + transitions; this list adds our app deps.
        name: 'codeseys-cloudflare-ssr-deps',
        configEnvironment(name) {
          if (name === 'client') return
          return {
            optimizeDeps: {
              include: [
                // React stack — heavy CJS interop, must be pre-bundled for workerd SSR
                'react',
                'react/jsx-runtime',
                'react-dom',
                'react-dom/server',
                // UI libraries used in .astro frontmatter and React islands
                'lucide-react',
                'class-variance-authority',
                'clsx',
                'tailwind-merge',
                // Radix primitives that ship CJS
                '@radix-ui/react-accordion',
                '@radix-ui/react-avatar',
                '@radix-ui/react-navigation-menu',
                '@radix-ui/react-scroll-area',
                '@radix-ui/react-separator',
                '@radix-ui/react-slot',
                '@radix-ui/react-tabs',
                // Other transitive CJS deps that surface during SSR
                'astro-navbar',
                'nanostores',
                '@nanostores/persistent',
              ],
            },
          }
        },
      },
    ],
    build: {
      target: 'esnext',
      minify: 'esbuild',
      cssMinify: true,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('node_modules')) {
              if (id.includes('react')) return 'react-vendor'
              if (id.includes('@radix-ui')) return 'ui'
            }
          },
        },
      },
    },
    optimizeDeps: {
      include: ['react', 'react-dom'],
      exclude: ['@astrojs/cloudflare'],
    },
  },
  prefetch: {
    prefetchAll: true,
    defaultStrategy: 'hover',
  },
})

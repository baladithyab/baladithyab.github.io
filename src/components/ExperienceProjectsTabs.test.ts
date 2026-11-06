import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { createServer, type ViteDevServer } from 'vite'
import { fileURLToPath } from 'node:url'

const props = {
  experiences: [
    {
      title: 'Fixture infrastructure engineer',
      company: 'Fixture research lab',
      date: '2024 – 2026',
      description: 'Built reliable data pipelines. Improved research tooling.',
    },
    {
      title: 'Fixture developer',
      company: 'Fixture software team',
      date: '2022 – 2024',
      description: 'Delivered accessible interfaces.',
    },
  ],
  projects: [
    { title: 'Fixture inactive project', description: 'Project details.' },
  ],
}

describe('ExperienceProjectsTabs server output', () => {
  let server: ViteDevServer
  let ExperienceProjectsTabs: ComponentType<typeof props>

  beforeAll(async () => {
    // Compile the real TSX and its local aliases without loading Astro's
    // application config, content pipeline, or Cloudflare runtime.
    server = await createServer({
      configFile: false,
      server: { middlewareMode: true, watch: null },
      appType: 'custom',
      resolve: {
        alias: { '@': fileURLToPath(new URL('../', import.meta.url)) },
      },
      esbuild: { jsx: 'automatic' },
    })
    const component = await server.ssrLoadModule(
      '/src/components/ExperienceProjectsTabs.tsx',
    )
    ExperienceProjectsTabs = component.default
  })

  afterAll(async () => {
    await server?.close()
  })

  it('includes supplied experience titles, metadata, and bullet details before hydration', () => {
    const html = renderToString(createElement(ExperienceProjectsTabs, props))
    const activePanel = html.match(
      /<div\b(?=[^>]*role="tabpanel")(?=[^>]*data-state="active")[^>]*>([\s\S]*?)<\/ul>/,
    )?.[1]
    expect(activePanel).toBeDefined()
    expect(activePanel).toContain('Fixture infrastructure engineer</h3>')
    expect(activePanel).toContain('Fixture research lab')
    expect(activePanel).toContain('2024 – 2026')
    expect(activePanel).toContain('Built reliable data pipelines.</li>')
    expect(activePanel).toContain('Improved research tooling.</li>')
    expect(html).toContain('Fixture developer</h3>')
    expect(html).toContain('Delivered accessible interfaces.</li>')
    expect(html).not.toContain('Fixture inactive project')
  })

  it('emits selected-tab semantics and connected tab/panel identifiers', () => {
    const html = renderToString(createElement(ExperienceProjectsTabs, props))
    const triggers = [...html.matchAll(/<button\b[^>]*role="tab"[^>]*>[^<]*<\/button>/g)]
    expect(triggers).toHaveLength(2)
    const experience = triggers.find(([tag]) => tag.endsWith('>Experience</button>'))?.[0]
    const projects = triggers.find(([tag]) => tag.endsWith('>Projects</button>'))?.[0]
    expect(experience).toContain('aria-selected="true"')
    expect(projects).toContain('aria-selected="false"')
    const triggerId = experience?.match(/\bid="([^"]+)"/)?.[1]
    const panelId = experience?.match(/aria-controls="([^"]+)"/)?.[1]
    const activePanel = html.match(
      /<div\b(?=[^>]*role="tabpanel")(?=[^>]*data-state="active")[^>]*>/,
    )?.[0]
    expect(triggerId).toBeTruthy()
    expect(panelId).toBeTruthy()
    expect(activePanel).toContain(`id="${panelId}"`)
    expect(activePanel).toContain(`aria-labelledby="${triggerId}"`)
    expect(activePanel).not.toContain('hidden=""')
  })
})

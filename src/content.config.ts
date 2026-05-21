import { defineCollection } from 'astro:content'
import { glob } from 'astro/loaders'
import { z } from 'astro/zod'

const blog = defineCollection({
  // Match both .md and .mdx — .mdx files can contain JSX components and the
  // Astro <Image /> component for proper image optimization. Plain markdown
  // posts continue to work unchanged.
  loader: glob({ base: './src/content/blog', pattern: '**/*.{md,mdx}' }),
  schema: ({ image }) =>
    z.object({
      title: z.string(),
      description: z.string().default(''),
      publishedAt: z.coerce.date(),
      updatedAt: z.coerce.date().optional(),
      tags: z.array(z.string()).default([]),
      draft: z.boolean().default(false),
      featured: z.boolean().default(false),
      relatedProject: z.string().optional(),
      githubUrl: z.url().optional(),
      demoUrl: z.url().optional(),
      sourceNotionId: z.string().optional(),
      // Cover image stored alongside the post (relative path resolved via
      // image() helper so the file is processed and optimised by Astro).
      cover: image().optional(),
      coverAlt: z.string().optional(),
    }),
})

export const collections = { blog }

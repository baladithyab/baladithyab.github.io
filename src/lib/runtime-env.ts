/**
 * Cloudflare Workers runtime env shim.
 *
 * Astro 6 + @astrojs/cloudflare 13 removed `Astro.locals.runtime.env`.
 * The replacement is `import { env } from 'cloudflare:workers'`, which
 * resolves inside the workerd runtime (Vite's `@cloudflare/vite-plugin`
 * provides it during dev/build).
 *
 * Reference: https://docs.astro.build/en/guides/integrations-guide/cloudflare/#environment-variables
 *
 * Use the typed re-exports at the call site, e.g.:
 *
 *     import { getRuntimeEnv } from '@/lib/runtime-env'
 *     import type { GitHubEnv } from '@/lib/github'
 *     const runtimeEnv = getRuntimeEnv<GitHubEnv>()
 */

import { env as workerEnv } from 'cloudflare:workers'

export type RuntimeEnv = Record<string, string | undefined> & {
    ASSETS?: { fetch: (request: Request) => Promise<Response> }
}

/**
 * Returns the Cloudflare Workers `env` object (bindings + secrets + vars).
 * Always defined when called from server-side Astro code under the Cloudflare
 * adapter; values are `undefined` for any binding/secret you haven't configured.
 *
 * Optionally pass a generic to type the expected variables, e.g.
 * `getRuntimeEnv<{ GITHUB_TOKEN?: string }>()`.
 */
export function getRuntimeEnv<T = RuntimeEnv>(): T {
    return workerEnv as unknown as T
}

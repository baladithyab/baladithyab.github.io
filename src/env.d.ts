/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />
/// <reference types="@cloudflare/workers-types" />

/**
 * Astro per-request locals.
 *
 * `Astro.locals.runtime.env` was removed in Astro 6 + @astrojs/cloudflare 13.
 * Use the `getRuntimeEnv()` helper in `@/lib/runtime-env` (which calls
 * `import { env } from 'cloudflare:workers'`) anywhere you previously read
 * from `locals.runtime.env`.
 *
 * `user` and `session` are populated by `src/middleware.ts` when OIDC is
 * configured (see `@/lib/auth`). They're `null` everywhere else.
 */
declare namespace App {
    interface Locals {
        user: import("@/lib/auth").AuthUser | null;
        session: import("@/lib/auth").AuthSession | null;
    }
}

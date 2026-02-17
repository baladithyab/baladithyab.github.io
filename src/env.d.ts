/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

/**
 * Better Auth types for Astro locals
 *
 * When Better Auth is configured, uncomment the imports below
 * and the types will be properly inferred from the auth instance.
 */
declare namespace App {
    interface Locals {
        runtime?: {
            env?: Record<string, any>;
        };
        user: import("@/lib/auth").AuthUser | null;
        session: import("@/lib/auth").AuthSession | null;
    }
}

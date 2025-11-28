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
        // TODO: Replace with actual Better Auth types when configured
        // user: import("better-auth").User | null;
        // session: import("better-auth").Session | null;
        user: {
            id: string;
            name: string;
            email: string;
            image?: string;
        } | null;
        session: {
            id: string;
            userId: string;
            expiresAt: Date;
        } | null;
    }
}

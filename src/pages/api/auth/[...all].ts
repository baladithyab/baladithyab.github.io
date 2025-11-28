/**
 * Better Auth API Route Handler
 * 
 * This catch-all route handles all authentication requests.
 * Uncomment when Better Auth is configured.
 * 
 * Routes handled:
 *   POST /api/auth/sign-in
 *   POST /api/auth/sign-up
 *   POST /api/auth/sign-out
 *   GET  /api/auth/session
 *   ...and more
 */

import type { APIRoute } from 'astro';
// import { auth } from '@/lib/auth';

// Uncomment when Better Auth is configured:
// export const ALL: APIRoute = async (ctx) => {
//   return auth.handler(ctx.request);
// };

// Placeholder response until auth is configured
export const ALL: APIRoute = async () => {
  return new Response(
    JSON.stringify({
      error: 'Authentication not configured',
      message: 'Better Auth integration is pending. See src/lib/auth.ts for setup instructions.',
    }),
    {
      status: 503,
      headers: {
        'Content-Type': 'application/json',
      },
    }
  );
};


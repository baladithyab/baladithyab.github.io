/**
 * Better Auth Client
 * 
 * This file contains the client-side Better Auth configuration.
 * Uncomment when ready to enable authentication.
 * 
 * For React components, use the React client:
 *   import { createAuthClient } from 'better-auth/react';
 * 
 * For vanilla JS/Astro components, use the vanilla client:
 *   import { createAuthClient } from 'better-auth/client';
 */

// Vanilla client (for Astro components)
// import { createAuthClient } from 'better-auth/client';
// export const authClient = createAuthClient();

// React client (for React components)
// import { createAuthClient } from 'better-auth/react';
// export const { 
//   signIn, 
//   signOut, 
//   signUp, 
//   useSession,
//   // ... other exports
// } = createAuthClient();

// Placeholder exports for type safety
export const authClient = null as any;
export const signIn = async () => { throw new Error('Auth not configured'); };
export const signOut = async () => { throw new Error('Auth not configured'); };
export const signUp = async () => { throw new Error('Auth not configured'); };


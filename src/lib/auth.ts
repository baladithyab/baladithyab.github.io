/**
 * Better Auth Configuration
 * 
 * This file contains the server-side Better Auth configuration.
 * Uncomment and configure when ready to enable authentication.
 * 
 * Installation:
 *   bun add better-auth
 * 
 * Documentation:
 *   https://www.better-auth.com/docs/integrations/astro
 */

// import { betterAuth } from 'better-auth';

// Example configuration with different database options:

// Option 1: SQLite (for development)
// import Database from 'better-sqlite3';
// 
// export const auth = betterAuth({
//   database: new Database('./auth.db'),
//   emailAndPassword: {
//     enabled: true,
//   },
//   socialProviders: {
//     github: {
//       clientId: import.meta.env.GITHUB_CLIENT_ID,
//       clientSecret: import.meta.env.GITHUB_CLIENT_SECRET,
//     },
//   },
// });

// Option 2: PostgreSQL/Supabase
// import { Pool } from 'pg';
// 
// export const auth = betterAuth({
//   database: new Pool({
//     connectionString: import.meta.env.DATABASE_URL,
//   }),
//   emailAndPassword: {
//     enabled: true,
//   },
// });

// Option 3: Cloudflare D1 (recommended for your setup)
// import { drizzle } from 'drizzle-orm/d1';
// 
// export const auth = betterAuth({
//   database: drizzle(/* D1 binding */),
//   emailAndPassword: {
//     enabled: true,
//   },
// });

// Placeholder export for type safety
export const auth = null as any;

// Type exports for use in other files
export type Auth = typeof auth;


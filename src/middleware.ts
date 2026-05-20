import { defineMiddleware } from 'astro:middleware';

import { type AuthEnv, getOidcConfig, getSessionFromRequest } from '@/lib/auth';
import { getRuntimeEnv } from '@/lib/runtime-env';

/**
 * Middleware for handling CORS and authentication
 */
export const onRequest = defineMiddleware(async (context, next) => {
    // Handle CORS preflight requests
    if (context.request.method === 'OPTIONS') {
        const origin = context.request.headers.get('Origin');
        const allowOrigin = origin && origin === context.url.origin ? origin : null;
        if (!allowOrigin) return new Response(null, { status: 204 });

        const headers = new Headers();
        headers.set('Access-Control-Allow-Origin', allowOrigin);
        headers.set('Vary', 'Origin');
        headers.set('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS,POST,PUT,DELETE');
        headers.set('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
        headers.set('Access-Control-Allow-Credentials', 'true');
        return new Response(null, { status: 204, headers });
    }

    // Auth (OIDC) session hydration: only active when configured.
    context.locals.user = null;
    context.locals.session = null;
    const runtimeEnv = getRuntimeEnv<AuthEnv>();
    const cfg = getOidcConfig(runtimeEnv);
    if (cfg) {
        const authed = await getSessionFromRequest(context.request, cfg);
        context.locals.user = authed?.user ?? null;
        context.locals.session = authed?.session ?? null;
    }

    const response = await next();

    // Add CORS headers to response (clone to ensure we preserve things like Set-Cookie).
    const newResponse = new Response(response.body, response);
    const origin = context.request.headers.get('Origin');
    const allowOrigin = origin && origin === context.url.origin ? origin : null;
    if (allowOrigin) {
        newResponse.headers.set('Access-Control-Allow-Origin', allowOrigin);
        newResponse.headers.set('Vary', 'Origin');
        newResponse.headers.set('Access-Control-Allow-Credentials', 'true');
        newResponse.headers.set('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS,POST,PUT,DELETE');
        newResponse.headers.set('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    }
    return newResponse;
});

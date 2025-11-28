import { defineMiddleware } from 'astro:middleware';

// TODO: Import auth when Better Auth is configured
// import { auth } from '@/lib/auth';

/**
 * Middleware for handling CORS and authentication
 *
 * When Better Auth is configured, uncomment the auth import and
 * add session validation logic below.
 */
export const onRequest = defineMiddleware(async (context, next) => {
    // Handle CORS preflight requests
    if (context.request.method === 'OPTIONS') {
        return new Response(null, {
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS,POST,PUT,DELETE',
                'Access-Control-Allow-Headers': 'Origin, X-Requested-With, Content-Type, Accept, Authorization',
            },
        });
    }

    // TODO: Add Better Auth session validation when configured
    // const session = await auth.api.getSession({
    //     headers: context.request.headers,
    // });
    //
    // if (session) {
    //     context.locals.user = session.user;
    //     context.locals.session = session.session;
    // } else {
    //     context.locals.user = null;
    //     context.locals.session = null;
    // }

    // For now, set auth locals to null
    context.locals.user = null;
    context.locals.session = null;

    const response = await next();

    // Add CORS headers to response
    const headers = new Headers(response.headers);
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS,POST,PUT,DELETE');
    headers.set('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');

    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
    });
});

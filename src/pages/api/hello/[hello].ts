// src/pages/api/hello/[name].ts
import type { APIRoute } from 'astro';

export const GET: APIRoute = ({ params, request }) => {

    const { name } = params;
    const greeting = `Hello, ${name}!`;

    return new Response(JSON.stringify({ greeting, params }), {
        status: 200,
        headers: {
            'Content-Type': 'application/json',
        },
    });
};
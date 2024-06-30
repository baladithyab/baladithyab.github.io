function isPathInUrl(urlString: string | URL, paths: any[]) {
    try {
        const url = new URL(urlString);
        return paths.some((path: string) => url.pathname.includes(path));
    } catch (error) {
        console.error('Invalid URL:', error);
        return false;
    }
}


export const onRequest = async (
    context: {
        [x: string]: any; request: { method: string; };
    },
    next: () => any
) => {
    if (context.request.method === 'OPTIONS') {
        let headers = new Headers();
        headers.append('Access-Control-Allow-Origin', '*');
        headers.append('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS,POST,PUT');
        headers.append('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
        return new Response(null, { headers });
    }


    const excludedPaths = ['/auth/callback', '/api/auth'];

    if (isPathInUrl(context.url, excludedPaths)) {
        // Skip middleware for these paths
        return await next();
    }

    const response = await next();
    // const clonedResponse = response.clone();
    // const body = await clonedResponse.json();

    // const logresp = await fetch('https://crudcrud.com/api/c3af5bcbd0824e3494c3cf2cdc46c3c8/unicorns', {
    //     method: 'POST',
    //     body: JSON.stringify({
    //         title: 'balatest',
    //         body: body,
    //     }),
    //     headers: {
    //         'Content-type': 'application/json; charset=UTF-8',
    //     },
    // });

    // console.log(logresp);

    const headers = new Headers(response.headers);
    headers.append('Access-Control-Allow-Origin', '*');
    headers.append('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS,POST,PUT');
    headers.append('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');

    return new Response(response.body, {
        ...response,
        headers: headers,
    });
}

// Cloudflare Worker that relays New Taipei's YouBike 2.0 live data to the web page.
// The city server doesn't send CORS headers, so browsers refuse to read it directly.
// Only the one dataset below is relayed, so this can't be used as an open proxy.

const NTPC_URL = page =>
  `https://data.ntpc.gov.tw/api/datasets/010e5b15-3823-4b20-b401-b1cf000550c5/json?page=${page}&size=1000`;

// Pages allowed to read through this relay.
const ALLOWED_ORIGINS = [
  'https://patty60723.github.io',
  'http://localhost:8000',
];

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Vary': 'Origin',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: cors });

    const url = new URL(request.url);
    if (url.pathname !== '/ntpc') return new Response('Not found', { status: 404, headers: cors });
    const page = Math.min(10, Math.max(0, parseInt(url.searchParams.get('page') || '0', 10) || 0));

    // Cache each page for 60 s at Cloudflare, matching the city's update rate.
    const upstream = await fetch(NTPC_URL(page), { cf: { cacheTtl: 60, cacheEverything: true } });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=60' },
    });
  },
};

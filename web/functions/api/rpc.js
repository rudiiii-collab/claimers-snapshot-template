// Optional CORS proxy — a Cloudflare Pages Function (free tier).
//
// The app talks to RPC endpoints directly from the browser; both defaults
// (Alchemy, publicnode) allow cross-origin requests. This proxy exists only
// for user-supplied endpoints that don't. The client flips to it automatically
// on a CORS/network failure (see public/js/rpc.js).
//
// POST /api/rpc?url=<https-endpoint>   body: the JSON-RPC request, verbatim.
//
// Privacy: the URL (which may embed the user's API key) and the body are
// forwarded upstream and NEVER logged or stored.

const MAX_BODY = 1 << 20; // 1 MiB request cap — JSON-RPC requests are small

export async function onRequestPost({ request }) {
  const target = new URL(request.url).searchParams.get('url');
  let upstream;
  try {
    upstream = new URL(target);
  } catch {
    return err(400, 'invalid url parameter');
  }
  if (upstream.protocol !== 'https:') return err(400, 'only https endpoints are allowed');
  // Refuse anything that could reach Cloudflare-internal or private space.
  if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1)/i.test(upstream.hostname)) {
    return err(400, 'private addresses are not allowed');
  }

  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BODY) return err(413, 'request too large');

  const resp = await fetch(upstream.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  return new Response(resp.body, {
    status: resp.status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

export function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  });
}

function err(status, message) {
  return new Response(JSON.stringify({ error: { code: -32000, message } }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

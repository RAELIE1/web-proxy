import { NextRequest, NextResponse } from "next/server";
import { rewriteHtml, rewriteCssUrls, makeProxyUrl } from "@/lib/rewrite";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Headers we strip from the outgoing request to the target
const BLOCKED_REQ_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "x-real-ip",
  "cf-ray",
  "cf-connecting-ip",
  "true-client-ip",
]);

// Headers we strip from the proxied response before sending to the browser
const BLOCKED_RES_HEADERS = new Set([
  "content-security-policy",
  "content-security-policy-report-only",
  "x-frame-options",
  "strict-transport-security",
  "transfer-encoding",
  "content-encoding", // We fully decode before rewriting
  "alt-svc",
]);

function parseTargetUrl(request: NextRequest): URL | null {
  const { searchParams } = new URL(request.url);
  const raw = searchParams.get("url");
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function handleProxy(request: NextRequest): Promise<NextResponse> {
  const target = parseTargetUrl(request);

  if (!target) {
    return NextResponse.json(
      { error: "Missing or invalid `url` query parameter." },
      { status: 400 }
    );
  }

  // Build forwarded request headers
  const reqHeaders = new Headers();
  for (const [key, value] of request.headers.entries()) {
    if (!BLOCKED_REQ_HEADERS.has(key.toLowerCase())) {
      reqHeaders.set(key, value);
    }
  }

  // Rewrite headers that would reveal the proxy's origin to Cloudflare / WAFs.
  // Without this, sec-fetch-site=cross-site + a proxy Referer triggers 403s.

  // Host must match the target
  reqHeaders.set("host", target.host);

  // Referer: rewrite our proxy URL back to the upstream page URL
  const rawReferer = request.headers.get("referer");
  if (rawReferer) {
    try {
      const proxiedUrl = new URL(rawReferer).searchParams.get("url");
      if (proxiedUrl) {
        reqHeaders.set("referer", proxiedUrl);
      } else {
        // Referer is not a proxy URL — make it look like it comes from the upstream origin
        reqHeaders.set("referer", target.origin + "/");
      }
    } catch {
      reqHeaders.delete("referer");
    }
  }

  // Origin: replace our proxy origin with the upstream origin
  if (reqHeaders.has("origin")) {
    reqHeaders.set("origin", target.origin);
  }

  // sec-fetch-site: resources loaded from the upstream origin by the upstream
  // page are same-origin fetches; cross-site is a clear proxy signal.
  if (reqHeaders.has("sec-fetch-site")) {
    reqHeaders.set("sec-fetch-site", "same-origin");
  }

  // Ensure a realistic User-Agent
  if (!reqHeaders.has("user-agent")) {
    reqHeaders.set(
      "user-agent",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    );
  }

  // Add baseline browser headers if absent
  if (!reqHeaders.has("accept")) {
    reqHeaders.set("accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8");
  }
  if (!reqHeaders.has("accept-language")) {
    reqHeaders.set("accept-language", "en-US,en;q=0.9");
  }

  // Remove accept-encoding override — Node 18's fetch (undici) negotiates
  // gzip/brotli automatically and decompresses transparently, so we no longer
  // need to force identity.  Sending identity is itself a bot signal.
  reqHeaders.delete("accept-encoding");

  // Body for non-GET/HEAD requests
  let body: ArrayBuffer | undefined;
  if (!["GET", "HEAD"].includes(request.method)) {
    body = await request.arrayBuffer();
  }

  let res: Response;
  try {
    res = await fetch(target.href, {
      method: request.method,
      headers: reqHeaders,
      body: body ?? null,
      redirect: "follow", // Next.js/Node fetch follows redirects and we get the final URL via res.url
      signal: AbortSignal.timeout(25_000),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown fetch error";
    return errorPage(
      502,
      "Upstream Error",
      `Could not reach ${target.origin}: ${message}`,
      target.href
    );
  }

  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  const finalUrl = res.url || target.href; // After redirects

  // Build response headers
  const resHeaders = new Headers();
  for (const [key, value] of res.headers.entries()) {
    if (!BLOCKED_RES_HEADERS.has(key.toLowerCase())) {
      resHeaders.set(key, value);
    }
  }

  // Rewrite Set-Cookie domain so cookies work
  const cookies = res.headers.getSetCookie?.() ?? [];
  for (const cookie of cookies) {
    const cleaned = cookie
      .replace(/;\s*domain=[^;]*/gi, "")
      .replace(/;\s*secure/gi, "")
      .replace(/;\s*samesite=[^;]*/gi, "");
    resHeaders.append("set-cookie", cleaned);
  }

  // Open up for embedding
  resHeaders.set("access-control-allow-origin", "*");
  resHeaders.delete("x-frame-options");

  // Track the proxied origin in a cookie so the middleware can redirect
  // root-relative asset requests even when there is no Referer header
  // (e.g. dynamic import(), web workers).
  try {
    const proxiedOrigin = new URL(finalUrl).origin;
    resHeaders.append(
      "set-cookie",
      `__proxy_origin=${encodeURIComponent(proxiedOrigin)}; Path=/; SameSite=Lax`
    );
  } catch { /* ignore malformed URLs */ }

  // ── No-body statuses (1xx, 204, 304) ─────────────────────────────────────
  // The HTTP spec forbids a message body for these; NextResponse throws if you pass one.
  const NO_BODY_STATUSES = new Set([101, 204, 205, 304]);
  if (NO_BODY_STATUSES.has(res.status) || res.status < 200) {
    return new NextResponse(null, { status: res.status, headers: resHeaders });
  }

  // ── HTML ──────────────────────────────────────────────────────────────────
  if (contentType.includes("text/html")) {
    const html = await res.text();
    const rewritten = rewriteHtml(html, finalUrl);
    resHeaders.set("content-type", "text/html; charset=utf-8");
    return new NextResponse(rewritten, {
      status: res.status,
      headers: resHeaders,
    });
  }

  // ── CSS ───────────────────────────────────────────────────────────────────
  if (contentType.includes("text/css")) {
    const css = await res.text();
    const rewritten = rewriteCssUrls(css, finalUrl);
    resHeaders.set("content-type", contentType);
    return new NextResponse(rewritten, {
      status: res.status,
      headers: resHeaders,
    });
  }

  // ── JavaScript ────────────────────────────────────────────────────────────
  if (
    contentType.includes("javascript") ||
    contentType.includes("application/x-javascript") ||
    contentType.includes("application/ecmascript")
  ) {
    let js = await res.text();

    // Vite/Rolldown bundles compute their chunk publicPath via:
    //   new URL('.', import.meta.url).href
    // When the script is served through our proxy, import.meta.url resolves
    // to the proxy URL (e.g. /proxy?url=https://chess.com/bundles/…/runtime.js),
    // so '.' strips back to the proxy root and all chunks load from '/'
    // (which chess.com returns 403/404 for).
    //
    // Fix: replace import.meta.url so relative chunk paths resolve against the
    // correct upstream directory instead of the proxy root.
    //
    // IMPORTANT: we replace with a variable name, NOT JSON.stringify(url).
    // JSON.stringify produces "https://..." (with embedded quotes).  If the
    // token appears inside an existing string literal in the source —
    // e.g.  var msg = "uses import.meta.url for resolution"  — inserting
    // quoted content breaks out of the enclosing string and produces a
    // "missing }" / "unexpected token" parse error.  A bare identifier is
    // syntactically valid in any position, so it never breaks the file.
    if (js.includes("import.meta.url")) {
      const imuVar = "__proxy_imu__";
      js = `var ${imuVar}=${JSON.stringify(finalUrl)};` +
           js.replaceAll("import.meta.url", imuVar);
    }

    // Also patch __webpack_public_path__ / __vite_public_path__ globals that
    // some older bundles set explicitly to location.origin + '/'.
    if (js.includes("__webpack_public_path__") || js.includes("__vite_public_path__")) {
      js = js.replace(
        /\b(__webpack_public_path__|__vite_public_path__)\s*=\s*(['"`])([^'"`]*)\2/g,
        (match, varName, _quote, path) => {
          try {
            const abs = new URL(path || "/", finalUrl).href;
            return `${varName}=${JSON.stringify(abs)}`;
          } catch {
            return match;
          }
        }
      );
    }

    return new NextResponse(js, { status: res.status, headers: resHeaders });
  }

  // ── Everything else: stream directly, no buffering ───────────────────────
  // JSON, XML, SVG, images, fonts, audio, video, wasm, etc. need no rewriting.
  // Passing res.body (a ReadableStream) avoids loading the whole asset into
  // memory before the first byte reaches the browser — critical for large images,
  // fonts, and video segments.
  return new NextResponse(res.body, { status: res.status, headers: resHeaders });
}

function errorPage(
  status: number,
  title: string,
  description: string,
  targetUrl: string
): NextResponse {
  const proxyHome = makeProxyUrl(targetUrl, targetUrl); // just for display
  void proxyHome; // unused

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${status} — ${title}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0f1117;color:#e8eaf0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:2rem;text-align:center}
    .wrap{display:flex;flex-direction:column;gap:1rem;align-items:center}
    .code{font-size:4rem;font-weight:700;color:#6c63ff}
    .title{font-size:1.25rem;font-weight:600}
    .desc{color:#8b8fa8;max-width:400px;line-height:1.6;font-size:.9rem}
    a{color:#6c63ff;text-decoration:none;font-weight:500;margin-top:.5rem;display:inline-block}
    a:hover{text-decoration:underline}
    pre{background:#1a1d27;border:1px solid #2e3147;border-radius:8px;padding:.75rem 1rem;font-size:.75rem;color:#8b8fa8;max-width:500px;overflow:auto;text-align:left;margin-top:.5rem}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="code">${status}</div>
    <div class="title">${title}</div>
    <div class="desc">${description}</div>
    <pre>${targetUrl}</pre>
    <a href="/">← Back to proxy home</a>
  </div>
</body>
</html>`;

  return new NextResponse(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export async function GET(request: NextRequest) {
  return handleProxy(request);
}

export async function POST(request: NextRequest) {
  return handleProxy(request);
}

export async function PUT(request: NextRequest) {
  return handleProxy(request);
}

export async function PATCH(request: NextRequest) {
  return handleProxy(request);
}

export async function DELETE(request: NextRequest) {
  return handleProxy(request);
}

export async function HEAD(request: NextRequest) {
  return handleProxy(request);
}

export async function OPTIONS(request: NextRequest) {
  return handleProxy(request);
}
